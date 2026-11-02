package apply

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/atomicio"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/state"
)

/*
 * Confirm-or-revert Apply, like Junos `commit confirmed`.
 *
 * An Apply that may cut the operator's connection arms a systemd timer before it
 * touches the firewall. Unless someone confirms in time, the timer runs
 * `evuproxy reload-revert`, which needs neither the API nor the operator. The timer
 * is a transient unit, so stopping or restarting the API leaves it running.
 *
 * Every timer carries a token, and only the token in the session file may revert.
 * That is what lets a repeat Apply arm its new timer before stopping the old one: at
 * every moment one timer can revert, and a leftover one finds it is out of date.
 */

// Why an Apply was reverted.
const (
	RevertReasonTimeout     = "timeout"
	RevertReasonManual      = "manual"
	RevertReasonInterrupted = "interrupted" // the session outlived its timer, usually a reboot
	RevertReasonFailedApply = "failed_apply"
)

// The phases of a session.
const (
	ConfirmPhaseActive      = "active"
	ConfirmPhaseRollingBack = "rolling_back"
	ConfirmPhaseFailed      = "failed"
)

// What systemd says about a session's timer.
type revertTimerState int

const (
	revertTimerLive revertTimerState = iota
	revertTimerDead
	// revertTimerUnclear is a hung or failing systemctl: the timer may well still be armed.
	revertTimerUnclear
)

const (
	confirmSessionDirName = ".evuproxy-apply-session"
	confirmSessionFile    = "session.json"
	lastRevertName        = ".evuproxy-apply-last-revert.json"
	revertedConfigSuffix  = ".reverted"
	revertTimerPrefix     = "evuproxy-apply-revert-"
	// A timer that fires during a slow Apply waits for it. One lock wait is shorter
	// than the API's five-minute Apply budget, so it takes several.
	revertLockAttempts = 3
	rollbackAttempts   = 3
	// How far past its deadline a session may run before it counts as stuck.
	confirmOverdueGrace = 30 * time.Second
)

var (
	// ErrConfirmSessionActive refuses a one-way reload: the timer would silently undo it.
	ErrConfirmSessionActive = errors.New("an Apply is waiting for confirmation: run `evuproxy reload-confirm` or `evuproxy reload-revert` first")
	// ErrNoConfirmSession means there is nothing to confirm or revert.
	ErrNoConfirmSession = errors.New("no Apply is waiting for confirmation")
	// ErrRollbackFailed means a revert did not finish and the host may still run the rejected config.
	ErrRollbackFailed = errors.New("reverting the last Apply failed")
	// ErrNoConfirmBaseline means there is no known-good config to revert to.
	ErrNoConfirmBaseline = errors.New("no known-good config to revert to: run `evuproxy reload` once first")
	// ErrConfirmUnavailable means the revert timer could not be armed. Nothing was changed.
	ErrConfirmUnavailable = errors.New("could not arm the revert timer (needs systemd and root); nothing was changed")
	// ErrNoRevertedConfig means no reverted config is being kept.
	ErrNoRevertedConfig = errors.New("no reverted config is being kept")
	// ErrPendingEditsExist protects unapplied edits from being replaced by a reverted config.
	ErrPendingEditsExist = errors.New("config.yaml has unapplied changes: apply or discard them first")
)

// rollbackRetryDelay is the pause between revert attempts. Package variable so tests don't wait.
var rollbackRetryDelay = 5 * time.Second

// currentBootID identifies this boot, or is empty if it can't be read. Package variable so tests can reboot.
var currentBootID = func() string {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ConfirmSession is an Apply waiting for confirmation, stored beside the config so
// an API restart or a reboot can find it.
type ConfirmSession struct {
	Phase          string    `json:"phase"`
	Token          string    `json:"token"`
	StartedAt      time.Time `json:"started_at"`
	Deadline       time.Time `json:"deadline"`
	TimeoutSeconds int       `json:"timeout_seconds"`
	// BootID is the boot the timer was armed in. Transient timers don't outlive it.
	BootID string `json:"boot_id,omitempty"`
	// RevertReason is set once a revert has started, and survives a failed attempt.
	RevertReason string `json:"revert_reason,omitempty"`
	Failure      string `json:"failure,omitempty"`
}

// ConfirmSessionView is a session as clients see it. The token stays private.
type ConfirmSessionView struct {
	Phase            string    `json:"phase"`
	StartedAt        time.Time `json:"started_at"`
	Deadline         time.Time `json:"deadline"`
	TimeoutSeconds   int       `json:"timeout_seconds"`
	RemainingSeconds int       `json:"remaining_seconds"`
	Failure          string    `json:"failure,omitempty"`
}

// LastRevert describes the most recent revert until it is dismissed.
type LastRevert struct {
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
	// ConfigAvailable is true when config.yaml.reverted holds the rejected config.
	ConfigAvailable bool `json:"config_available"`
}

// ConfirmStatus answers GET /apply/session and `evuproxy reload-status`.
type ConfirmStatus struct {
	ConfirmEnabled        bool                `json:"confirm_enabled"`
	ConfirmTimeoutSeconds int                 `json:"confirm_timeout_seconds"`
	Session               *ConfirmSessionView `json:"session"`
	LastRevert            *LastRevert         `json:"last_revert"`
}

func confirmSessionDir(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), confirmSessionDirName)
}

func confirmSessionPath(cfgPath string) string {
	return filepath.Join(confirmSessionDir(cfgPath), confirmSessionFile)
}

func lastRevertPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), lastRevertName)
}

// RevertedConfigPath is where a revert keeps the config it rejected.
func RevertedConfigPath(cfgPath string) string {
	return cfgPath + revertedConfigSuffix
}

// isConfirmStateEntry reports whether a path relative to the config directory is
// session state. A backup must not carry it: restoring an old session later would
// look like one that outlived its timer, and revert the host to a stale baseline.
func isConfirmStateEntry(rel string) bool {
	first, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	return first == confirmSessionDirName || first == lastRevertName
}

// readConfirmSession returns the session on disk, or nil when there is none.
func readConfirmSession(cfgPath string) (*ConfirmSession, error) {
	b, err := os.ReadFile(confirmSessionPath(cfgPath))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read apply session: %w", err)
	}
	var s ConfirmSession
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("apply session: %w", err)
	}
	return &s, nil
}

func writeConfirmSession(cfgPath string, s *ConfirmSession) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return atomicio.WriteFile(confirmSessionPath(cfgPath), b, 0o600)
}

func emitConfirmEvent(cfgPath string, rec eventlog.Record) {
	el, err := eventlog.New(filepath.Dir(cfgPath), eventlog.MaxBytesFromEnv())
	if err == nil {
		err = el.Append(rec)
	}
	if err != nil {
		slog.Warn("eventlog append", "err", err)
	}
}

func newRevertToken() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func revertUnit(token string) string {
	return revertTimerPrefix + token
}

// armRevertTimer starts the transient timer that reverts unless it is stopped first.
func armRevertTimer(ctx context.Context, cfgPath, token string, timeoutSeconds int) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(cfgPath)
	if err != nil {
		return err
	}
	out, err := runCmdCombined(ctx, "systemd-run",
		"--no-ask-password",
		"--collect",
		"--unit="+revertUnit(token),
		"--description=EvuProxy: revert an unconfirmed Apply",
		"--on-active="+strconv.Itoa(timeoutSeconds)+"s",
		"--timer-property=AccuracySec=1s",
		"--property=Type=oneshot",
		exe, "--config", abs, "reload-revert", "--reason", RevertReasonTimeout, "--token", token,
	)
	if err != nil {
		return fmt.Errorf("systemd-run: %w: %s", err, TruncateForLog(string(out), 1024))
	}
	return nil
}

// stopRevertTimer is best effort: a timer that still fires finds its token out of date.
func stopRevertTimer(ctx context.Context, token string) {
	if out, err := runCmdCombined(ctx, "systemctl", "stop", revertUnit(token)+".timer"); err != nil {
		slog.Debug("stop revert timer", "err", err, "out", TruncateForLog(string(out), 512))
	}
}

// sessionTimerState reports whether the session's timer can still fire. A timer from an
// earlier boot is gone whatever systemctl says, which matters at boot: the host has no
// firewall yet, so the boot unit must revert rather than wait for a clear answer. Within a
// boot only an explicit answer counts as dead: a hung systemctl must not trigger a revert.
func sessionTimerState(ctx context.Context, s *ConfirmSession) revertTimerState {
	if boot := currentBootID(); boot != "" && s.BootID != "" && boot != s.BootID {
		return revertTimerDead
	}
	out, err := runCmdOutput(ctx, "systemctl", "is-active", revertUnit(s.Token)+".timer")
	switch answer := strings.TrimSpace(string(out)); answer {
	case "active", "activating", "reloading", "deactivating":
		return revertTimerLive
	case "inactive", "failed", "unknown":
		return revertTimerDead
	default:
		slog.Warn("could not tell whether the revert timer is armed", "answer", answer, "err", err)
		return revertTimerUnclear
	}
}

// checkConfirmBaseline makes sure .bak really is what the host is running and could
// be applied again. Reverting to anything else could make matters worse.
func checkConfirmBaseline(cfgPath string) error {
	bak, err := os.ReadFile(state.ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNoConfirmBaseline
		}
		return err
	}
	applied, err := state.ReadAppliedHash(cfgPath)
	if err != nil {
		return err
	}
	h := sha256.Sum256(bak)
	if applied != hex.EncodeToString(h[:]) {
		return ErrNoConfirmBaseline
	}
	if err := state.ValidateConfigYAML(bak); err != nil {
		return fmt.Errorf("%w: %v", ErrNoConfirmBaseline, err)
	}
	return nil
}

// snapshotConfirmBaseline copies .bak and its history into a new session directory.
func snapshotConfirmBaseline(cfgPath string) error {
	dir := confirmSessionDir(cfgPath)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for _, p := range state.ConfigYAMLHistoryPaths(cfgPath) {
		b, err := os.ReadFile(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if err := atomicio.WriteFile(filepath.Join(dir, filepath.Base(p)), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// restoreConfirmBaseline puts config.yaml and its history back as they were before the
// session. It keeps whatever config.yaml holds that isn't the baseline, including edits
// saved since the Apply, and it is safe to repeat after a failed or interrupted attempt.
func restoreConfirmBaseline(cfgPath string) error {
	dir := confirmSessionDir(cfgPath)
	bakPath := state.ConfigYAMLBackupPath(cfgPath)
	baseline, err := os.ReadFile(filepath.Join(dir, filepath.Base(bakPath)))
	if err != nil {
		return fmt.Errorf("read baseline: %w", err)
	}
	cur, err := os.ReadFile(cfgPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && !bytes.Equal(cur, baseline) {
		if err := atomicio.WriteFile(RevertedConfigPath(cfgPath), cur, 0o644); err != nil {
			return fmt.Errorf("keep rejected config: %w", err)
		}
	}
	if err := atomicio.WriteFile(cfgPath, baseline, 0o644); err != nil {
		return err
	}
	for _, p := range state.ConfigYAMLHistoryPaths(cfgPath) {
		b, err := os.ReadFile(filepath.Join(dir, filepath.Base(p)))
		switch {
		case err == nil:
			err = atomicio.WriteFile(p, b, 0o644)
		case os.IsNotExist(err):
			err = os.Remove(p)
			if os.IsNotExist(err) {
				err = nil
			}
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// rollbackLocked reverts the session. The caller holds the apply lock. reload applies
// the firewall before WireGuard, so a WireGuard failure still leaves the firewall reverted.
// restoreEdits puts a failed Apply's edits back in config.yaml. Only pass it when someone
// is there to see them: a plain reload, or a boot with confirm off, applies what config.yaml holds.
func rollbackLocked(ctx context.Context, cfgPath string, s *ConfirmSession, reason string, restoreEdits bool) error {
	stopRevertTimer(ctx, s.Token)
	if s.RevertReason == "" {
		s.RevertReason = reason
	}
	s.Phase = ConfirmPhaseRollingBack
	s.Failure = ""
	if err := writeConfirmSession(cfgPath, s); err != nil {
		slog.Warn("apply session", "err", err)
	}
	err := restoreConfirmBaseline(cfgPath)
	if err == nil {
		for attempt := 1; attempt <= rollbackAttempts; attempt++ {
			if err = reload(ctx, cfgPath, func(string) {}); err == nil {
				break
			}
			slog.Error("revert attempt failed", "attempt", attempt, "err", err)
			if attempt < rollbackAttempts {
				time.Sleep(rollbackRetryDelay)
			}
		}
	}
	if err != nil {
		s.Phase = ConfirmPhaseFailed
		s.Failure = TruncateForLog(err.Error(), 512)
		if werr := writeConfirmSession(cfgPath, s); werr != nil {
			slog.Error("apply session", "err", werr)
		}
		emitConfirmEvent(cfgPath, eventlog.Record{Event: "apply_revert_failed", Detail: s.Failure, ErrorCode: "apply_revert_error"})
		return fmt.Errorf("%w: %v", ErrRollbackFailed, err)
	}

	// A failed Apply isn't a rejection: the edits go back to being unapplied changes,
	// as they do when an Apply fails without a session.
	if s.RevertReason == RevertReasonFailedApply && restoreEdits {
		if err := os.Rename(RevertedConfigPath(cfgPath), cfgPath); err != nil && !os.IsNotExist(err) {
			slog.Error("restore edits after failed apply", "err", err)
		}
	} else {
		writeLastRevert(cfgPath, s.RevertReason)
	}
	if err := os.RemoveAll(confirmSessionDir(cfgPath)); err != nil {
		slog.Error("clear apply session", "err", err)
	}
	emitConfirmEvent(cfgPath, eventlog.Record{Event: "apply_reverted", Detail: s.RevertReason})
	return nil
}

func writeLastRevert(cfgPath, reason string) {
	b, err := json.Marshal(LastRevert{At: time.Now().UTC(), Reason: reason})
	if err == nil {
		err = atomicio.WriteFile(lastRevertPath(cfgPath), b, 0o644)
	}
	if err != nil {
		slog.Warn("record last revert", "err", err)
	}
}

func clearLastRevert(cfgPath string) {
	_ = os.Remove(lastRevertPath(cfgPath))
	_ = os.Remove(RevertedConfigPath(cfgPath))
}

// checkOneWayReload runs before a reload that won't be confirmed, with the apply lock
// held. A live session refuses it, and so does an unclear answer: that can't be a boot,
// so the firewall is still in place. One that outlived its timer is reverted first: its
// config.yaml was never confirmed, and this may be the boot unit about to apply it. That
// leaves config.yaml as the baseline, so the reload that follows applies nothing rejected.
func checkOneWayReload(ctx context.Context, cfgPath string) error {
	s, err := readConfirmSession(cfgPath)
	if err != nil || s == nil {
		return err
	}
	if s.Phase == ConfirmPhaseActive && sessionTimerState(ctx, s) != revertTimerDead {
		return ErrConfirmSessionActive
	}
	return rollbackLocked(ctx, cfgPath, s, RevertReasonInterrupted, false)
}

// ReloadAtBoot is what evuproxy.service runs, at boot and on a unit restart. With confirm
// on it applies the last confirmed config and leaves any edits in config.yaml as unapplied
// changes: nobody is there to confirm them, and a config that locks the host out would stay
// live. Everything else applies config.yaml like Reload.
func ReloadAtBoot(ctx context.Context, cfgPath string) error {
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkOneWayReload(ctx, cfgPath); err != nil {
		return err
	}
	if err := reloadAtBoot(ctx, cfgPath); err != nil {
		_ = state.RecordApplyFailure(cfgPath)
		return err
	}
	_ = state.RecordApplySuccess(cfgPath)
	return nil
}

func reloadAtBoot(ctx context.Context, cfgPath string) error {
	noProgress := func(string) {}
	c, err := loadConfirmBaseline(cfgPath)
	if err != nil {
		// With no known config to prefer, the alternative is a host with no firewall.
		slog.Warn("no usable last applied config at boot; applying config.yaml", "err", err)
		return reload(ctx, cfgPath, noProgress)
	}
	// Read from .bak, so that an unapplied edit can't turn confirm off and get itself applied.
	if !c.Apply.Confirm {
		return reload(ctx, cfgPath, noProgress)
	}
	// checkConfirmBaseline has just shown the applied hash is the hash of .bak.
	applied, _ := state.ReadAppliedHash(cfgPath)
	if cur, err := state.ConfigFileSHA256(cfgPath); err != nil || cur != applied {
		slog.Warn("config.yaml has unapplied changes; applying the last confirmed config instead. Run `evuproxy reload` to apply them")
	}
	// .bak and the applied hash already describe this config, so there is nothing to record.
	// If it fails, the failure is the answer: the edits are still not confirmed.
	if err := applyToHost(ctx, c, cfgPath, noProgress); err != nil {
		return err
	}
	afterApply(c, cfgPath)
	return nil
}

// loadConfirmBaseline returns the last applied config, if it is known to be that.
func loadConfirmBaseline(cfgPath string) (*config.Config, error) {
	if err := checkConfirmBaseline(cfgPath); err != nil {
		return nil, err
	}
	return config.Load(state.ConfigYAMLBackupPath(cfgPath))
}

// RecoverConfirmSession reverts a session that outlived its timer. `evuproxy serve` calls
// it at startup, so a restart inside the window leaves a session with a live timer alone.
func RecoverConfirmSession(ctx context.Context, cfgPath string) error {
	if s, err := readConfirmSession(cfgPath); err != nil || s == nil {
		return err
	}
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := readConfirmSession(cfgPath)
	if err != nil || s == nil {
		return err
	}
	if s.Phase == ConfirmPhaseActive && sessionTimerState(ctx, s) != revertTimerDead {
		return nil
	}
	return rollbackLocked(ctx, cfgPath, s, RevertReasonInterrupted, false)
}

// ReloadWithConfirm applies config.yaml and reverts it unless ConfirmApply is called
// within timeoutSeconds. Applying again during the window restarts the wait and keeps the
// same revert target: the last confirmed config. A failure reverts the host straight away
// and leaves the edits in config.yaml as unapplied changes.
func ReloadWithConfirm(ctx context.Context, cfgPath string, timeoutSeconds int, progress func(step string)) (*ConfirmSessionView, error) {
	if timeoutSeconds < config.MinConfirmTimeoutSeconds || timeoutSeconds > config.MaxConfirmTimeoutSeconds {
		return nil, fmt.Errorf("confirm timeout must be %d to %d seconds", config.MinConfirmTimeoutSeconds, config.MaxConfirmTimeoutSeconds)
	}
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return nil, err
	}
	defer unlock()

	s, err := readConfirmSession(cfgPath)
	if err != nil {
		return nil, err
	}
	if s != nil && s.Phase != ConfirmPhaseActive {
		return nil, fmt.Errorf("%w: %s", ErrRollbackFailed, s.Failure)
	}
	first := s == nil
	if first {
		if err := checkConfirmBaseline(cfgPath); err != nil {
			return nil, err
		}
		if err := snapshotConfirmBaseline(cfgPath); err != nil {
			return nil, fmt.Errorf("snapshot baseline: %w", err)
		}
		s = &ConfirmSession{Phase: ConfirmPhaseActive, StartedAt: time.Now().UTC()}
	}
	s.TimeoutSeconds = timeoutSeconds
	// Armed before the firewall is touched, so a crash from here on still reverts.
	if err := rearmConfirmSession(ctx, cfgPath, s); err != nil {
		if first {
			_ = os.RemoveAll(confirmSessionDir(cfgPath))
		}
		return nil, fmt.Errorf("%w: %v", ErrConfirmUnavailable, err)
	}
	if first {
		clearLastRevert(cfgPath)
	}

	if err := reload(ctx, cfgPath, progress); err != nil {
		_ = state.RecordApplyFailure(cfgPath)
		if rerr := rollbackLocked(ctx, cfgPath, s, RevertReasonFailedApply, true); rerr != nil {
			return nil, errors.Join(err, rerr)
		}
		return nil, err
	}
	_ = state.RecordApplySuccess(cfgPath)

	// The wait starts now: a slow Apply must not use up the operator's time to answer.
	if err := rearmConfirmSession(ctx, cfgPath, s); err != nil {
		slog.Warn("restart revert timer after apply; the earlier deadline stands", "err", err)
	}
	return s.view(time.Now()), nil
}

// rearmConfirmSession arms a new timer, records it, then stops the one it replaces. Until
// the record is written the old timer is the valid one; after that, only the new one.
func rearmConfirmSession(ctx context.Context, cfgPath string, s *ConfirmSession) error {
	token, err := newRevertToken()
	if err != nil {
		return err
	}
	if err := armRevertTimer(ctx, cfgPath, token, s.TimeoutSeconds); err != nil {
		return err
	}
	next := *s
	next.Token = token
	next.BootID = currentBootID()
	next.Deadline = time.Now().UTC().Add(time.Duration(s.TimeoutSeconds) * time.Second)
	if err := writeConfirmSession(cfgPath, &next); err != nil {
		stopRevertTimer(ctx, token)
		return err
	}
	if s.Token != "" {
		stopRevertTimer(ctx, s.Token)
	}
	*s = next
	return nil
}

// ConfirmApply keeps the applied config. Clearing the session is what decides it: if the
// timer is already firing, it finds no session and leaves the host alone.
func ConfirmApply(ctx context.Context, cfgPath string) error {
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := readConfirmSession(cfgPath)
	if err != nil {
		return err
	}
	if s == nil {
		return ErrNoConfirmSession
	}
	if s.Phase != ConfirmPhaseActive {
		return fmt.Errorf("%w: %s", ErrRollbackFailed, s.Failure)
	}
	if err := os.RemoveAll(confirmSessionDir(cfgPath)); err != nil {
		return fmt.Errorf("clear apply session: %w", err)
	}
	stopRevertTimer(ctx, s.Token)
	emitConfirmEvent(cfgPath, eventlog.Record{Event: "apply_confirmed", Detail: "confirm"})
	return nil
}

// RevertApply reverts the waiting Apply now, or retries a revert that failed. A non-empty
// token makes it a no-op unless that token is current, which is how the timer calls it.
func RevertApply(ctx context.Context, cfgPath, reason, token string) error {
	var unlock func()
	var err error
	for attempt := 1; attempt <= revertLockAttempts; attempt++ {
		if unlock, err = acquireApplyLock(ctx, cfgPath); err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	defer unlock()
	s, err := readConfirmSession(cfgPath)
	if err != nil {
		return err
	}
	if s == nil {
		return ErrNoConfirmSession
	}
	if token != "" && token != s.Token {
		return ErrNoConfirmSession
	}
	return rollbackLocked(ctx, cfgPath, s, reason, true)
}

func (s *ConfirmSession) view(now time.Time) *ConfirmSessionView {
	remaining := int(s.Deadline.Sub(now).Round(time.Second) / time.Second)
	if remaining < 0 {
		remaining = 0
	}
	return &ConfirmSessionView{
		Phase:            s.Phase,
		StartedAt:        s.StartedAt,
		Deadline:         s.Deadline,
		TimeoutSeconds:   s.TimeoutSeconds,
		RemainingSeconds: remaining,
		Failure:          s.Failure,
	}
}

// rollbackInterrupted reports whether a session still says rolling_back with nobody doing
// it. A revert holds the apply lock throughout, so a free lock means it was killed. The
// session is read again under the lock, since the revert may have just finished.
func rollbackInterrupted(cfgPath string) bool {
	unlock, ok := tryApplyLock(cfgPath)
	if !ok {
		return false
	}
	defer unlock()
	s, err := readConfirmSession(cfgPath)
	return err == nil && s != nil && s.Phase == ConfirmPhaseRollingBack
}

// ReadConfirmStatus reports the setting, any session and the last revert. A session well
// past its deadline with no timer left will never revert by itself, and a killed revert
// will never finish, so both read as failed: that's what offers a retry.
func ReadConfirmStatus(ctx context.Context, cfgPath string) (ConfirmStatus, error) {
	st := ConfirmStatus{ConfirmTimeoutSeconds: config.DefaultConfirmTimeoutSeconds}
	if c, err := config.Load(cfgPath); err == nil {
		st.ConfirmEnabled = c.Apply.Confirm
		st.ConfirmTimeoutSeconds = c.Apply.EffectiveConfirmTimeoutSeconds()
	}
	s, err := readConfirmSession(cfgPath)
	if err != nil {
		return st, err
	}
	if s != nil {
		now := time.Now()
		st.Session = s.view(now)
		if s.Phase == ConfirmPhaseActive && now.After(s.Deadline.Add(confirmOverdueGrace)) && sessionTimerState(ctx, s) == revertTimerDead {
			st.Session.Phase = ConfirmPhaseFailed
			st.Session.Failure = "the revert timer ended without reverting"
		}
		if s.Phase == ConfirmPhaseRollingBack && rollbackInterrupted(cfgPath) {
			st.Session.Phase = ConfirmPhaseFailed
			st.Session.Failure = "the revert was stopped before it finished"
		}
	}
	if b, err := os.ReadFile(lastRevertPath(cfgPath)); err == nil {
		var lr LastRevert
		if json.Unmarshal(b, &lr) == nil {
			_, serr := os.Stat(RevertedConfigPath(cfgPath))
			lr.ConfigAvailable = serr == nil
			st.LastRevert = &lr
		}
	}
	return st, nil
}

// RestoreRevertedConfig brings a reverted config back as unapplied changes. It refuses to
// replace edits made since the revert.
func RestoreRevertedConfig(ctx context.Context, cfgPath string) error {
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	if s, err := readConfirmSession(cfgPath); err != nil {
		return err
	} else if s != nil {
		return ErrConfirmSessionActive
	}
	rejected, err := os.ReadFile(RevertedConfigPath(cfgPath))
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNoRevertedConfig
		}
		return err
	}
	if err := state.ValidateConfigYAML(rejected); err != nil {
		return fmt.Errorf("reverted config invalid: %w", err)
	}
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}
	bak, err := os.ReadFile(state.ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		return err
	}
	if !bytes.Equal(cur, bak) {
		return ErrPendingEditsExist
	}
	if err := atomicio.WriteFile(cfgPath, rejected, 0o644); err != nil {
		return err
	}
	clearLastRevert(cfgPath)
	return nil
}

// DismissLastRevert forgets the last revert and the config it kept.
func DismissLastRevert(ctx context.Context, cfgPath string) error {
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	clearLastRevert(cfgPath)
	return nil
}
