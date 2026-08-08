/*
 * Shared pre-apply lockout check.
 *
 * `POST /v1/reload` rewrites nftables and reloads WireGuard, so a bad config can
 * cut the operator off from SSH and from this UI. `POST /v1/validate` reports
 * that risk as `lockout_risk_*` warnings; nothing on the server refuses the
 * reload, so this is the only thing standing between the operator and a
 * self-inflicted lockout. Both Apply (Pending changes) and Reload config
 * (Overview) go through here — a second, ungated apply button is the same hole
 * as having no gate at all.
 *
 * Two rules the callers depend on:
 *
 *  1. Everything is derived from the response body, never from a "we ran a
 *     check" flag. A flag survives the config changing underneath it; a 200 with
 *     an unexpected shape sets it just as happily as a real pass.
 *  2. Anything unexpected fails closed. An unparseable result, a missing field
 *     or a request that never completed all block the apply.
 */

import { api } from "./api.js";

const LOCKOUT_CODE_PREFIX = "lockout_risk_";

/**
 * A /validate body we are willing to make a safety decision on.
 *
 * `ok` must really be a boolean: `undefined` from an unexpected 200 (an nginx
 * interstitial, a future API change) would otherwise read as "no errors, no
 * warnings" and wave the apply through.
 */
function isValidateShape(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.ok !== "boolean") return false;
  if (body.warnings != null && !Array.isArray(body.warnings)) return false;
  if (body.errors != null && !Array.isArray(body.errors)) return false;
  return true;
}

/** The `lockout_risk_*` subset — the warnings that require acknowledgement. */
export function lockoutRisks(res) {
  if (!res || !Array.isArray(res.warnings)) return [];
  return res.warnings.filter(
    (w) => w && typeof w.code === "string" && w.code.startsWith(LOCKOUT_CODE_PREFIX)
  );
}

/**
 * Identity of a set of risks, so an acknowledgement can be bound to the exact
 * warnings the operator read. Editing the config between ticking the box and
 * pressing Apply produces a different signature, which revokes the tick.
 */
export function lockoutSignature(risks) {
  return risks
    .map((w) => String(w.code) + ":" + String(w.message || ""))
    .sort()
    .join("|");
}

/**
 * Runs the check.
 *
 * Resolves to `{ res }` on a body we can reason about, or `{ error }` — never
 * both, and never a usable-looking result from a response we did not understand.
 * A failed check (`ok: false`) is a successful call: the caller needs the error
 * list to show the operator what to fix.
 */
export async function fetchValidateResult() {
  try {
    const body = await api("/v1/validate", { method: "POST" });
    if (!isValidateShape(body)) {
      return { error: "Config check returned an unexpected response; not applying." };
    }
    return { res: body };
  } catch (e) {
    // /validate answers 400 when the config is invalid, so the failure body is
    // the result we want rather than an error to report.
    if (isValidateShape(e.body)) return { res: e.body };
    return { error: String(e.message || e) };
  }
}

/** Human-readable summary of the risks, for the Overview confirm dialog. */
export function lockoutRiskLines(risks) {
  return risks.map((w) => "• " + String(w.message || w.code));
}
