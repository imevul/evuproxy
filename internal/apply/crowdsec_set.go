package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net"
	"strings"
)

// crowdsecBlockSet identifies the CrowdSec ban set in the inet evuproxy table.
const (
	crowdsecFamily = "inet"
	crowdsecTable  = "evuproxy"
	crowdsecSet    = "crowdsec_block_v4"
)

// crowdsecElem is a single ban entry captured from the live nftables set,
// preserving its remaining timeout so re-adding after a reload does not turn a
// temporary ban into a permanent one.
type crowdsecElem struct {
	val     string
	timeout int // remaining seconds, 0 = no timeout
}

// snapshotCrowdsecBlockSet reads current elements of the CrowdSec ban set via
// `nft -j list set`. Reload recreates the set empty (the generated ruleset
// declares it with no elements), so without this the bans would be silently
// flushed on every apply. Best-effort: returns nil if the set is absent or nft
// is unavailable.
func snapshotCrowdsecBlockSet(ctx context.Context) []crowdsecElem {
	out, err := runCmdOutput(ctx, "nft", "-j", "list", "set", crowdsecFamily, crowdsecTable, crowdsecSet)
	if err != nil {
		// Set missing (first install) or nft unavailable — nothing to preserve.
		return nil
	}
	elems, err := parseCrowdsecSetJSON(out)
	if err != nil {
		slog.Debug("crowdsec set snapshot parse", "err", err)
		return nil
	}
	return elems
}

// restoreCrowdsecBlockSet re-adds previously captured ban entries after the
// table has been replaced. Best-effort and idempotent; a bouncer refresh will
// reconcile the set regardless.
func restoreCrowdsecBlockSet(ctx context.Context, elems []crowdsecElem) {
	if len(elems) == 0 {
		return
	}
	var parts []string
	for _, e := range elems {
		v := strings.TrimSpace(e.val)
		// Defense in depth: values come from nft's own JSON output today, but they
		// are interpolated into a set-element literal, so accept only IP/CIDR.
		if !validCrowdsecElemVal(v) {
			continue
		}
		if e.timeout > 0 {
			parts = append(parts, fmt.Sprintf("%s timeout %ds", v, e.timeout))
		} else {
			parts = append(parts, v)
		}
	}
	if len(parts) == 0 {
		return
	}
	spec := fmt.Sprintf("%s %s %s { %s }", crowdsecFamily, crowdsecTable, crowdsecSet, strings.Join(parts, ", "))
	if out, err := runCmdCombined(ctx, "nft", "add", "element", crowdsecFamily, crowdsecTable, crowdsecSet, "{", strings.Join(parts, ", "), "}"); err != nil {
		slog.Warn("crowdsec bans not restored after reload; awaiting bouncer refresh", "err", err, "spec", spec, "output", TruncateForLog(string(out), 1024))
		return
	}
	slog.Info("restored crowdsec bans across reload", "count", len(parts))
}

// nftSetListJSON mirrors the subset of `nft -j list set` output we need.
type nftSetListJSON struct {
	Nftables []struct {
		Set *struct {
			Elem []json.RawMessage `json:"elem"`
		} `json:"set"`
	} `json:"nftables"`
}

// parseCrowdsecSetJSON extracts element values and remaining timeouts. Elements
// appear either as bare strings ("1.2.3.4") or objects with elem.val/elem.expires.
func parseCrowdsecSetJSON(data []byte) ([]crowdsecElem, error) {
	var doc nftSetListJSON
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	var out []crowdsecElem
	for _, item := range doc.Nftables {
		if item.Set == nil {
			continue
		}
		for _, raw := range item.Set.Elem {
			e, ok := parseCrowdsecElem(raw)
			if ok {
				out = append(out, e)
			}
		}
	}
	return out, nil
}

func parseCrowdsecElem(raw json.RawMessage) (crowdsecElem, bool) {
	// Bare string form: "1.2.3.4".
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if strings.TrimSpace(s) == "" {
			return crowdsecElem{}, false
		}
		return crowdsecElem{val: s}, true
	}
	// Object form: {"elem": {"val": "1.2.3.4", "expires": 3500}}. Expires may be
	// fractional (nft emits remaining time); absent means no timeout (permanent).
	var obj struct {
		Elem *struct {
			Val     json.RawMessage `json:"val"`
			Expires *float64        `json:"expires"`
		} `json:"elem"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil || obj.Elem == nil {
		return crowdsecElem{}, false
	}
	val, ok := crowdsecElemVal(obj.Elem.Val)
	if !ok {
		return crowdsecElem{}, false
	}
	timeout := 0
	if obj.Elem.Expires != nil {
		// Clamp a timed ban that is about to lapse to 1s rather than re-adding it
		// without a timeout (which would make a temporary ban permanent).
		timeout = int(math.Ceil(*obj.Elem.Expires))
		if timeout < 1 {
			timeout = 1
		}
	}
	return crowdsecElem{val: val, timeout: timeout}, true
}

// validCrowdsecElemVal accepts a bare IP or CIDR, nothing else.
func validCrowdsecElemVal(v string) bool {
	if v == "" {
		return false
	}
	if strings.Contains(v, "/") {
		_, _, err := net.ParseCIDR(v)
		return err == nil
	}
	return net.ParseIP(v) != nil
}

// crowdsecElemVal renders a set element value which may be a plain address
// string or a prefix object {"prefix": {"addr": "1.2.3.0", "len": 24}}.
func crowdsecElemVal(raw json.RawMessage) (string, bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if strings.TrimSpace(s) == "" {
			return "", false
		}
		return s, true
	}
	var pfx struct {
		Prefix *struct {
			Addr string `json:"addr"`
			Len  int    `json:"len"`
		} `json:"prefix"`
	}
	if err := json.Unmarshal(raw, &pfx); err == nil && pfx.Prefix != nil && pfx.Prefix.Addr != "" {
		return fmt.Sprintf("%s/%d", pfx.Prefix.Addr, pfx.Prefix.Len), true
	}
	return "", false
}
