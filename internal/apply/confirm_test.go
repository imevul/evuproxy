package apply

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

// confirmEnv is a host with an applied config and a fake systemd that tracks live timers.
type confirmEnv struct {
	t        *testing.T
	f        *fakeRunner
	cfgPath  string
	baseline []byte
	timers   map[string]bool // unit name -> armed
	failNft  bool
	failWG   bool
	failArm  bool
	bootID   string
	// isActive overrides the fake systemd's answer about a timer, when set.
	isActive func() ([]byte, error)
}

func newConfirmEnv(t *testing.T) *confirmEnv {
	t.Helper()
	e := &confirmEnv{t: t, timers: map[string]bool{}, bootID: "boot-1"}
	prevBootID := currentBootID
	currentBootID = func() string { return e.bootID }
	t.Cleanup(func() { currentBootID = prevBootID })
	e.f = &fakeRunner{handler: e.handle}
	withFakeReloadEnv(t, e.f, true)
	prevDelay := rollbackRetryDelay
	rollbackRetryDelay = time.Millisecond
	t.Cleanup(func() { rollbackRetryDelay = prevDelay })
	e.cfgPath = writeReloadTestConfig(t)
	if err := Reload(context.Background(), e.cfgPath); err != nil {
		t.Fatalf("baseline reload: %v", err)
	}
	b, err := os.ReadFile(e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	e.baseline = b
	return e
}

func (e *confirmEnv) handle(name string, args []string) ([]byte, error) {
	joined := strings.Join(args, " ")
	switch name {
	case "systemd-run":
		if e.failArm {
			return []byte("Failed to connect to bus"), errors.New("exit 1")
		}
		for _, a := range args {
			if unit, ok := strings.CutPrefix(a, "--unit="); ok {
				e.timers[unit] = true
			}
		}
	case "systemctl":
		unit := strings.TrimSuffix(args[len(args)-1], ".timer")
		switch args[0] {
		case "stop":
			delete(e.timers, unit)
		case "is-active":
			if e.isActive != nil {
				return e.isActive()
			}
			if e.timers[unit] {
				return []byte("active\n"), nil
			}
			return []byte("inactive\n"), errors.New("exit 3")
		}
	case "nft":
		if e.failNft && strings.HasPrefix(joined, "-f") {
			return []byte("nft broke"), errors.New("exit 1")
		}
	case "wg":
		if e.failWG {
			return []byte("wg broke"), errors.New("exit 1")
		}
	}
	return nil, nil
}

// edit stands in for PUT /config: the config on disk moves away from what is applied.
func (e *confirmEnv) edit(marker string) []byte {
	e.t.Helper()
	b := append(append([]byte{}, e.baseline...), []byte("# "+marker+"\n")...)
	if err := os.WriteFile(e.cfgPath, b, 0o644); err != nil {
		e.t.Fatal(err)
	}
	return b
}

func (e *confirmEnv) session() *ConfirmSession {
	e.t.Helper()
	s, err := readConfirmSession(e.cfgPath)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *confirmEnv) apply() *ConfirmSessionView {
	e.t.Helper()
	v, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {})
	if err != nil {
		e.t.Fatalf("ReloadWithConfirm: %v", err)
	}
	return v
}

// fire does what the timer's `evuproxy reload-revert --token` does.
func (e *confirmEnv) fire(token string) error {
	return RevertApply(context.Background(), e.cfgPath, RevertReasonTimeout, token)
}

func (e *confirmEnv) wantFile(path string, want []byte) {
	e.t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		e.t.Fatal(err)
	}
	if string(got) != string(want) {
		e.t.Fatalf("%s:\n got %q\nwant %q", filepath.Base(path), got, want)
	}
}

func (e *confirmEnv) wantNoFile(path string) {
	e.t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		e.t.Fatalf("%s should not exist (err=%v)", filepath.Base(path), err)
	}
}

func TestConfirm_armsTimerBeforeTouchingFirewall(t *testing.T) {
	e := newConfirmEnv(t)
	e.f.calls = nil
	e.edit("change")
	e.apply()
	armed, loaded := e.f.callIndex("systemd-run"), e.f.callIndex("nft -f")
	if armed < 0 || loaded < 0 || armed > loaded {
		t.Fatalf("timer must be armed before nft load (armed=%d loaded=%d): %v", armed, loaded, e.f.calls)
	}
	call := e.f.calls[armed]
	for _, want := range []string{"--on-active=60s", "reload-revert", "--token", "--config " + e.cfgPath} {
		if !strings.Contains(call, want) {
			t.Fatalf("systemd-run call missing %q: %s", want, call)
		}
	}
}

func TestConfirm_timerRestartsAfterApply(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("change")
	e.apply()
	if len(e.timers) != 1 {
		t.Fatalf("exactly one timer should be left armed: %v", e.timers)
	}
	if !e.timers[revertUnit(e.session().Token)] {
		t.Fatalf("the armed timer is not the session's: %v", e.timers)
	}
}

func TestConfirm_keepsConfigAndStopsTimer(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.edit("change")
	e.apply()
	token := e.session().Token
	if err := ConfirmApply(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	if len(e.timers) != 0 {
		t.Fatalf("timer should be stopped: %v", e.timers)
	}
	e.wantFile(e.cfgPath, edited)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), edited)

	// A timer that had already fired loses the race harmlessly.
	if err := e.fire(token); !errors.Is(err, ErrNoConfirmSession) {
		t.Fatalf("late timer: %v", err)
	}
	e.wantFile(e.cfgPath, edited)
}

func TestConfirm_withoutSession(t *testing.T) {
	e := newConfirmEnv(t)
	if err := ConfirmApply(context.Background(), e.cfgPath); !errors.Is(err, ErrNoConfirmSession) {
		t.Fatalf("got %v", err)
	}
}

func TestTimeout_revertsConfigHistoryAndFirewall(t *testing.T) {
	e := newConfirmEnv(t)
	// Give the history something the Apply would rotate.
	older := e.edit("older")
	if err := Reload(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	e.baseline = older
	bak1, err := os.ReadFile(e.cfgPath + ".bak.1")
	if err != nil {
		t.Fatal(err)
	}
	rejected := e.edit("rejected")
	e.apply()
	token := e.session().Token
	e.f.calls = nil

	if err := e.fire(token); err != nil {
		t.Fatal(err)
	}
	if e.f.callIndex("nft -f") < 0 {
		t.Fatalf("revert should reload the firewall: %v", e.f.calls)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	e.wantFile(e.cfgPath, older)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), older)
	e.wantFile(e.cfgPath+".bak.1", bak1)
	e.wantFile(RevertedConfigPath(e.cfgPath), rejected)
	applied, err := state.ReadAppliedHash(e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cur, _ := state.ConfigFileSHA256(e.cfgPath); applied != cur {
		t.Fatalf("applied hash %s should match reverted config %s", applied, cur)
	}

	st, err := ReadConfirmStatus(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Session != nil || st.LastRevert == nil || st.LastRevert.Reason != RevertReasonTimeout || !st.LastRevert.ConfigAvailable {
		t.Fatalf("status: %+v", st)
	}
}

func TestTimeout_keepsEditsSavedDuringTheWindow(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("applied")
	e.apply()
	token := e.session().Token
	later := e.edit("saved after the apply")
	if err := e.fire(token); err != nil {
		t.Fatal(err)
	}
	e.wantFile(RevertedConfigPath(e.cfgPath), later)
}

func TestRepeatApply_restartsTimerAndKeepsRevertTarget(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("first")
	e.apply()
	first := e.session()

	second := e.edit("second")
	view := e.apply()
	s := e.session()
	if s.Token == first.Token {
		t.Fatal("repeat Apply should arm a new timer")
	}
	if e.timers[revertUnit(first.Token)] {
		t.Fatal("old timer should be stopped")
	}
	if len(e.timers) != 1 || !e.timers[revertUnit(s.Token)] {
		t.Fatalf("timers: %v", e.timers)
	}
	if view.RemainingSeconds < 58 {
		t.Fatalf("the wait should restart, remaining=%d", view.RemainingSeconds)
	}
	if !s.StartedAt.Equal(first.StartedAt) {
		t.Fatal("still the same session")
	}

	// The old timer, had it fired anyway, must not revert.
	if err := e.fire(first.Token); !errors.Is(err, ErrNoConfirmSession) {
		t.Fatalf("stale timer: %v", err)
	}
	e.wantFile(e.cfgPath, second)

	// The target is the last confirmed config, not the first unconfirmed Apply.
	if err := e.fire(s.Token); err != nil {
		t.Fatal(err)
	}
	e.wantFile(e.cfgPath, e.baseline)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), e.baseline)
	e.wantFile(RevertedConfigPath(e.cfgPath), second)
}

func TestRepeatApply_armFailureLeavesSessionRunning(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("first")
	e.apply()
	before := e.session()
	e.failArm = true
	e.f.calls = nil
	if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {}); !errors.Is(err, ErrConfirmUnavailable) {
		t.Fatalf("got %v", err)
	}
	if e.f.callIndex("nft -f") >= 0 {
		t.Fatal("firewall must not be touched")
	}
	if got := e.session(); got == nil || got.Token != before.Token {
		t.Fatalf("session should be unchanged: %+v", got)
	}
	if !e.timers[revertUnit(before.Token)] {
		t.Fatal("old timer must keep running")
	}
}

func TestArmFailure_changesNothing(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.edit("change")
	e.failArm = true
	e.f.calls = nil
	if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {}); !errors.Is(err, ErrConfirmUnavailable) {
		t.Fatalf("got %v", err)
	}
	if e.f.callIndex("nft") >= 0 {
		t.Fatalf("firewall must not be touched: %v", e.f.calls)
	}
	if e.session() != nil {
		t.Fatal("no session should remain")
	}
	e.wantNoFile(confirmSessionDir(e.cfgPath))
	e.wantFile(e.cfgPath, edited)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), e.baseline)
}

func TestNoBaseline_refuses(t *testing.T) {
	e := newConfirmEnv(t)
	for name, breakIt := range map[string]func(){
		"no .bak": func() { _ = os.Remove(state.ConfigYAMLBackupPath(e.cfgPath)) },
		"hash differs": func() {
			_ = state.WriteAppliedConfigHash(e.cfgPath, "not the hash of .bak")
		},
	} {
		t.Run(name, func(t *testing.T) {
			breakIt()
			e.f.calls = nil
			if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {}); !errors.Is(err, ErrNoConfirmBaseline) {
				t.Fatalf("got %v", err)
			}
			if len(e.f.calls) != 0 {
				t.Fatalf("nothing should run: %v", e.f.calls)
			}
			if err := Reload(context.Background(), e.cfgPath); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTimeoutBounds(t *testing.T) {
	e := newConfirmEnv(t)
	for _, secs := range []int{0, config.MinConfirmTimeoutSeconds - 1, config.MaxConfirmTimeoutSeconds + 1} {
		if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, secs, func(string) {}); err == nil {
			t.Fatalf("%d seconds should be refused", secs)
		}
	}
}

func TestOneWayReload_refusedDuringWindow(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.edit("change")
	e.apply()
	e.f.calls = nil
	if err := Reload(context.Background(), e.cfgPath); !errors.Is(err, ErrConfirmSessionActive) {
		t.Fatalf("got %v", err)
	}
	if e.f.callIndex("nft") >= 0 {
		t.Fatalf("firewall must not be touched: %v", e.f.calls)
	}
	e.wantFile(e.cfgPath, edited)
}

// After a reboot the transient timer is gone, and the boot unit runs a plain reload of a
// config.yaml nobody confirmed. It must get the last confirmed config instead.
func TestReboot_bootReloadRevertsFirst(t *testing.T) {
	e := newConfirmEnv(t)
	rejected := e.edit("change")
	e.apply()
	clear(e.timers) // reboot

	if err := Reload(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	e.wantFile(e.cfgPath, e.baseline)
	e.wantFile(RevertedConfigPath(e.cfgPath), rejected)
	st, err := ReadConfirmStatus(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.LastRevert == nil || st.LastRevert.Reason != RevertReasonInterrupted {
		t.Fatalf("status: %+v", st.LastRevert)
	}
}

func TestRecover_apiRestart(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.edit("change")
	e.apply()

	// Restarted inside the window: the timer is still there, so the session stands.
	if err := RecoverConfirmSession(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	if e.session() == nil {
		t.Fatal("session should survive an API restart")
	}
	e.wantFile(e.cfgPath, edited)

	// Started after a reboot: no timer, so it reverts.
	clear(e.timers)
	if err := RecoverConfirmSession(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	e.wantFile(e.cfgPath, e.baseline)
}

func TestRecover_withoutSessionRunsNothing(t *testing.T) {
	e := newConfirmEnv(t)
	e.f.calls = nil
	if err := RecoverConfirmSession(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	if len(e.f.calls) != 0 {
		t.Fatalf("calls: %v", e.f.calls)
	}
}

func TestFailedRollback_recordsThenRetrySucceeds(t *testing.T) {
	e := newConfirmEnv(t)
	rejected := e.edit("change")
	e.apply()
	token := e.session().Token
	e.failNft = true
	e.f.calls = nil

	if err := e.fire(token); !errors.Is(err, ErrRollbackFailed) {
		t.Fatalf("got %v", err)
	}
	loads := 0
	for _, c := range e.f.calls {
		if strings.HasPrefix(c, "nft -f") {
			loads++
		}
	}
	if loads != rollbackAttempts {
		t.Fatalf("attempts: got %d want %d", loads, rollbackAttempts)
	}
	s := e.session()
	if s == nil || s.Phase != ConfirmPhaseFailed || !strings.Contains(s.Failure, "nft broke") {
		t.Fatalf("session: %+v", s)
	}
	// config.yaml is already the baseline, so a reboot can't bring the rejected one back.
	e.wantFile(e.cfgPath, e.baseline)
	e.wantFile(RevertedConfigPath(e.cfgPath), rejected)

	if err := ConfirmApply(context.Background(), e.cfgPath); !errors.Is(err, ErrRollbackFailed) {
		t.Fatalf("confirm during failed rollback: %v", err)
	}
	if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {}); !errors.Is(err, ErrRollbackFailed) {
		t.Fatalf("apply during failed rollback: %v", err)
	}

	e.failNft = false
	if err := RevertApply(context.Background(), e.cfgPath, RevertReasonManual, ""); err != nil {
		t.Fatal(err)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	e.wantFile(RevertedConfigPath(e.cfgPath), rejected)
	st, _ := ReadConfirmStatus(context.Background(), e.cfgPath)
	if st.LastRevert == nil || st.LastRevert.Reason != RevertReasonTimeout {
		t.Fatalf("the first reason should stand: %+v", st.LastRevert)
	}
}

func TestFailedRollback_wireguardFailureStillRevertsFirewall(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("change")
	e.apply()
	token := e.session().Token
	e.failWG = true
	e.f.calls = nil
	if err := e.fire(token); !errors.Is(err, ErrRollbackFailed) {
		t.Fatalf("got %v", err)
	}
	loaded, synced := e.f.callIndex("nft -f"), e.f.callIndex("wg syncconf")
	if loaded < 0 || synced < 0 || loaded > synced {
		t.Fatalf("firewall must go first (nft=%d wg=%d): %v", loaded, synced, e.f.calls)
	}
}

func TestFailedApply_revertsLiveStateAndKeepsEdits(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.edit("change")
	e.failWG = true
	// The first reload (with the edits) fails on WireGuard; the revert must then succeed.
	calls := 0
	e.f.handler = func(name string, args []string) ([]byte, error) {
		if name == "wg" {
			calls++
			if calls > 1 {
				e.failWG = false
			}
		}
		return e.handle(name, args)
	}
	if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {}); err == nil {
		t.Fatal("apply should fail")
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	if len(e.timers) != 0 {
		t.Fatalf("timers: %v", e.timers)
	}
	e.wantFile(e.cfgPath, edited)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), e.baseline)
	e.wantNoFile(RevertedConfigPath(e.cfgPath))
	st, _ := ReadConfirmStatus(context.Background(), e.cfgPath)
	if st.LastRevert != nil {
		t.Fatalf("a failed Apply is not a revert to report: %+v", st.LastRevert)
	}
	p, err := PendingSummary(e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Pending {
		t.Fatal("the edits should be unapplied changes")
	}
}

func TestRestoreRevertedConfig(t *testing.T) {
	e := newConfirmEnv(t)
	rejected := e.edit("rejected")
	e.apply()
	if err := e.fire(e.session().Token); err != nil {
		t.Fatal(err)
	}

	unsaved := e.edit("edited since")
	if err := RestoreRevertedConfig(context.Background(), e.cfgPath); !errors.Is(err, ErrPendingEditsExist) {
		t.Fatalf("got %v", err)
	}
	e.wantFile(e.cfgPath, unsaved)

	if err := os.WriteFile(e.cfgPath, e.baseline, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RestoreRevertedConfig(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	e.wantFile(e.cfgPath, rejected)
	e.wantNoFile(RevertedConfigPath(e.cfgPath))
	if err := RestoreRevertedConfig(context.Background(), e.cfgPath); !errors.Is(err, ErrNoRevertedConfig) {
		t.Fatalf("got %v", err)
	}
}

func TestDismissLastRevert(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("rejected")
	e.apply()
	if err := e.fire(e.session().Token); err != nil {
		t.Fatal(err)
	}
	if err := DismissLastRevert(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	st, _ := ReadConfirmStatus(context.Background(), e.cfgPath)
	if st.LastRevert != nil {
		t.Fatalf("status: %+v", st.LastRevert)
	}
	e.wantNoFile(RevertedConfigPath(e.cfgPath))
}

func TestNewSession_retiresLastRevert(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("rejected")
	e.apply()
	if err := e.fire(e.session().Token); err != nil {
		t.Fatal(err)
	}
	e.edit("another try")
	e.apply()
	st, _ := ReadConfirmStatus(context.Background(), e.cfgPath)
	if st.LastRevert != nil {
		t.Fatalf("status: %+v", st.LastRevert)
	}
}

func TestStatus_stuckSessionReadsAsFailed(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("change")
	e.apply()
	st, err := ReadConfirmStatus(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Session == nil || st.Session.Phase != ConfirmPhaseActive || st.Session.RemainingSeconds < 58 {
		t.Fatalf("session: %+v", st.Session)
	}
	s := e.session()
	s.Deadline = time.Now().Add(-time.Hour)
	if err := writeConfirmSession(e.cfgPath, s); err != nil {
		t.Fatal(err)
	}
	clear(e.timers)
	st, err = ReadConfirmStatus(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Session.Phase != ConfirmPhaseFailed || st.Session.RemainingSeconds != 0 {
		t.Fatalf("session: %+v", st.Session)
	}
}

// An Apply that fails after the firewall went live, with a revert that fails the same way.
// reload loads nft before WireGuard, so one WireGuard fault does both.
func (e *confirmEnv) failApplyAndRevert() []byte {
	e.t.Helper()
	edited := e.edit("failed apply")
	e.failWG = true
	if _, err := ReloadWithConfirm(context.Background(), e.cfgPath, 60, func(string) {}); !errors.Is(err, ErrRollbackFailed) {
		e.t.Fatalf("got %v", err)
	}
	s := e.session()
	if s == nil || s.Phase != ConfirmPhaseFailed || s.RevertReason != RevertReasonFailedApply {
		e.t.Fatalf("session: %+v", s)
	}
	e.wantFile(e.cfgPath, e.baseline)
	e.failWG = false
	return edited
}

func (e *confirmEnv) wantEditsKeptOut(edited []byte) {
	e.t.Helper()
	if e.session() != nil {
		e.t.Fatal("session should be cleared")
	}
	e.wantFile(e.cfgPath, e.baseline)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), e.baseline)
	e.wantFile(RevertedConfigPath(e.cfgPath), edited)
	st, err := ReadConfirmStatus(context.Background(), e.cfgPath)
	if err != nil {
		e.t.Fatal(err)
	}
	if st.LastRevert == nil || st.LastRevert.Reason != RevertReasonFailedApply || !st.LastRevert.ConfigAvailable {
		e.t.Fatalf("status: %+v", st.LastRevert)
	}
}

// The boot unit applies whatever config.yaml holds, with no timer to undo it, so the failed
// edits must not be back there when it does, on this boot or the next.
func TestFailedApplyAndRevert_bootKeepsEditsOut(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.failApplyAndRevert()
	e.bootID = "boot-2"
	clear(e.timers)

	if err := Reload(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	e.wantEditsKeptOut(edited)

	e.bootID = "boot-3"
	if err := Reload(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	e.wantFile(e.cfgPath, e.baseline)
}

func TestFailedApplyAndRevert_serveStartupKeepsEditsOut(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.failApplyAndRevert()
	if err := RecoverConfirmSession(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	e.wantEditsKeptOut(edited)
}

func TestFailedApplyAndRevert_stillFailingBootKeepsFirewallReverted(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.failApplyAndRevert()
	e.bootID = "boot-2"
	e.failWG = true
	if err := Reload(context.Background(), e.cfgPath); !errors.Is(err, ErrRollbackFailed) {
		t.Fatalf("got %v", err)
	}
	if s := e.session(); s == nil || s.Phase != ConfirmPhaseFailed {
		t.Fatalf("session: %+v", s)
	}
	e.wantFile(e.cfgPath, e.baseline)
	e.wantFile(RevertedConfigPath(e.cfgPath), edited)
}

// Someone pressing Retry sees the result, so the edits come back as unapplied changes.
func TestFailedApplyAndRevert_retryRestoresEdits(t *testing.T) {
	e := newConfirmEnv(t)
	edited := e.failApplyAndRevert()
	if err := RevertApply(context.Background(), e.cfgPath, RevertReasonManual, ""); err != nil {
		t.Fatal(err)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	e.wantFile(e.cfgPath, edited)
	e.wantNoFile(RevertedConfigPath(e.cfgPath))
	st, _ := ReadConfirmStatus(context.Background(), e.cfgPath)
	if st.LastRevert != nil {
		t.Fatalf("status: %+v", st.LastRevert)
	}
}

// killedCommandError is the error os/exec really returns for a command that hit its
// timeout, which is not context.DeadlineExceeded.
func killedCommandError(t *testing.T) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	err := exec.CommandContext(ctx, "sleep", "30").Run()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	return err
}

func unclearSystemctlAnswers(t *testing.T) map[string]func() ([]byte, error) {
	killed := killedCommandError(t)
	return map[string]func() ([]byte, error){
		"hung":   func() ([]byte, error) { return nil, killed },
		"no bus": func() ([]byte, error) { return nil, errors.New("exit status 1") },
		"binary": func() ([]byte, error) { return nil, exec.ErrNotFound },
	}
}

func TestUnclearTimerState_leavesSessionAlone(t *testing.T) {
	for name, answer := range unclearSystemctlAnswers(t) {
		t.Run(name, func(t *testing.T) {
			e := newConfirmEnv(t)
			edited := e.edit("change")
			e.apply()
			e.isActive = answer

			if err := RecoverConfirmSession(context.Background(), e.cfgPath); err != nil {
				t.Fatal(err)
			}
			if s := e.session(); s == nil || s.Phase != ConfirmPhaseActive {
				t.Fatalf("serve startup should leave the session: %+v", s)
			}
			if err := Reload(context.Background(), e.cfgPath); !errors.Is(err, ErrConfirmSessionActive) {
				t.Fatalf("one-way reload: %v", err)
			}
			e.wantFile(e.cfgPath, edited)

			s := e.session()
			s.Deadline = time.Now().Add(-time.Hour)
			if err := writeConfirmSession(e.cfgPath, s); err != nil {
				t.Fatal(err)
			}
			st, err := ReadConfirmStatus(context.Background(), e.cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			if st.Session.Phase != ConfirmPhaseActive {
				t.Fatalf("an overdue session with an unclear timer isn't known to be stuck: %+v", st.Session)
			}
		})
	}
}

// At boot the host has no firewall yet, so systemctl's answer must not be able to stop the
// revert and the reload after it. The timer can't have survived, whatever it says.
func TestReboot_unclearSystemctlStillReverts(t *testing.T) {
	for name, answer := range unclearSystemctlAnswers(t) {
		t.Run(name, func(t *testing.T) {
			e := newConfirmEnv(t)
			rejected := e.edit("change")
			e.apply()
			clear(e.timers)
			e.bootID = "boot-2"
			e.isActive = answer

			if err := Reload(context.Background(), e.cfgPath); err != nil {
				t.Fatal(err)
			}
			if e.session() != nil {
				t.Fatal("session should be cleared")
			}
			e.wantFile(e.cfgPath, e.baseline)
			e.wantFile(RevertedConfigPath(e.cfgPath), rejected)
		})
	}
}

func TestTimerState_clearAnswers(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("change")
	e.apply()
	s := e.session()
	for answer, want := range map[string]revertTimerState{
		"active\n":       revertTimerLive,
		"deactivating\n": revertTimerLive,
		"inactive\n":     revertTimerDead,
		"failed\n":       revertTimerDead,
		"unknown\n":      revertTimerDead,
		"\n":             revertTimerUnclear,
	} {
		e.isActive = func() ([]byte, error) { return []byte(answer), errors.New("exit 3") }
		if got := sessionTimerState(context.Background(), s); got != want {
			t.Errorf("%q: got %v want %v", answer, got, want)
		}
	}
}

// A revert holds the apply lock throughout, so rolling_back with a free lock is one that
// was killed. It has to offer a retry instead of saying "Reverting…" forever.
func TestStatus_killedRevertReadsAsFailed(t *testing.T) {
	e := newConfirmEnv(t)
	rejected := e.edit("change")
	e.apply()
	s := e.session()
	s.Phase = ConfirmPhaseRollingBack
	s.RevertReason = RevertReasonTimeout
	if err := writeConfirmSession(e.cfgPath, s); err != nil {
		t.Fatal(err)
	}

	unlock, err := acquireApplyLock(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	st, err := ReadConfirmStatus(context.Background(), e.cfgPath)
	unlock()
	if err != nil {
		t.Fatal(err)
	}
	if st.Session.Phase != ConfirmPhaseRollingBack {
		t.Fatalf("while the lock is held it is still running: %+v", st.Session)
	}

	st, err = ReadConfirmStatus(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Session.Phase != ConfirmPhaseFailed || st.Session.Failure == "" {
		t.Fatalf("session: %+v", st.Session)
	}
	// Reading it must leave the lock free for the retry.
	if err := RevertApply(context.Background(), e.cfgPath, RevertReasonManual, ""); err != nil {
		t.Fatal(err)
	}
	if e.session() != nil {
		t.Fatal("session should be cleared")
	}
	e.wantFile(e.cfgPath, e.baseline)
	e.wantFile(RevertedConfigPath(e.cfgPath), rejected)
	st, _ = ReadConfirmStatus(context.Background(), e.cfgPath)
	if st.LastRevert == nil || st.LastRevert.Reason != RevertReasonTimeout {
		t.Fatalf("status: %+v", st.LastRevert)
	}
}

func TestRestore_refusedDuringWindow(t *testing.T) {
	e := newConfirmEnv(t)
	e.edit("change")
	e.apply()
	if err := Restore(e.cfgPath, "/var/backups/x.tgz"); !errors.Is(err, ErrConfirmSessionActive) {
		t.Fatalf("got %v", err)
	}
}

func TestBackup_leavesSessionStateOut(t *testing.T) {
	e := newConfirmEnv(t)
	dir := t.TempDir()
	t.Setenv("EVUPROXY_BACKUP_DIR", dir)
	e.f.calls = nil
	if err := Backup(context.Background(), e.cfgPath, filepath.Join(dir, "a.tgz")); err != nil {
		t.Fatal(err)
	}
	i := e.f.callIndex("tar")
	if i < 0 || !strings.Contains(e.f.calls[i], "--exclude=./"+confirmSessionDirName) || !strings.Contains(e.f.calls[i], "--exclude=./"+lastRevertName) {
		t.Fatalf("tar: %v", e.f.calls)
	}
	for rel, want := range map[string]bool{
		confirmSessionDirName + "/session.json": true,
		lastRevertName:                          true,
		"config.yaml":                           false,
		"state/events.jsonl":                    false,
	} {
		if got := isConfirmStateEntry(rel); got != want {
			t.Fatalf("isConfirmStateEntry(%q) = %v", rel, got)
		}
	}
}
