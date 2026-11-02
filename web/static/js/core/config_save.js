/**
 * Saving the config without losing changes made elsewhere.
 *
 * PUT /config replaces the whole file, so a stale tab would revert everything saved
 * since it loaded. Saves therefore send the revision their base config came with; on
 * a 409 the edit is reapplied to a freshly fetched config and retried.
 */
import { state } from "./state.js";
import { api, responseEtag } from "./api.js";

const REVISION_MISMATCH = "config_revision_mismatch";
const MAX_SAVE_ATTEMPTS = 3;

/** An edit that no longer applies to the latest config. The message is shown to the user. */
export class ConfigMergeError extends Error {}

export function isConfigRevisionMismatch(e) {
  return !!e && e.errorCode === REVISION_MISMATCH;
}

/**
 * PUT cfg as a save based on revision, then adopt the server's copy as state.lastConfig.
 * Reading it back picks up normalization, so later comparisons against a fresh GET hold.
 * No revision means an API older than this UI (the two deploy separately): no ETag to
 * send, so the save stays unconditional there.
 */
export async function putConfigAtRevision(cfg, revision) {
  await api("/v1/config", {
    method: "PUT",
    headers: revision ? { "If-Match": revision } : {},
    body: JSON.stringify(cfg),
  });
  try {
    state.lastConfig = await api("/v1/config");
  } catch {
    // Saved, but the read-back failed. No revision on this copy, so the next save re-fetches.
    state.lastConfig = cfg;
  }
  return state.lastConfig;
}

/**
 * Apply edit to a copy of state.lastConfig and save it, reapplying to fresh config if
 * another save got there first. edit(draft) mutates the draft and must be safe to run
 * again on different data: find rows with findConfigRow, not a remembered index. It may
 * throw ConfigMergeError, or return false to skip the save.
 *
 * Resolves to the new state.lastConfig. On failure state.lastConfig may have moved to
 * the fresh config, so callers should re-render from it.
 */
export async function saveConfigEdit(edit) {
  if (!state.lastConfig || !responseEtag(state.lastConfig)) {
    state.lastConfig = await api("/v1/config");
  }
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    const base = state.lastConfig;
    const draft = JSON.parse(JSON.stringify(base));
    if (edit(draft) === false) return base;
    try {
      return await putConfigAtRevision(draft, responseEtag(base));
    } catch (e) {
      if (!isConfigRevisionMismatch(e)) throw e;
      state.lastConfig = await api("/v1/config");
    }
  }
  throw new ConfigMergeError("The saved config kept changing elsewhere, so your change was not saved. Try again.");
}

export function resolveListIndex(list, openIndex, identity, identityOf) {
  // Prefer the open-time index when it still matches (handles duplicate keys).
  if (!list) return -1;
  if (list[openIndex] != null && identityOf(list[openIndex]) === identity) return openIndex;
  const matches = [];
  for (let i = 0; i < list.length; i++) {
    if (identityOf(list[i]) === identity) matches.push(i);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return -1;
  return -2; // ambiguous after list churn
}

/** Index of the row the user acted on, or ConfigMergeError naming it (what: "route"). */
export function findConfigRow(list, openIndex, identity, identityOf, what) {
  const i = resolveListIndex(list, openIndex, identity, identityOf);
  if (i === -1) {
    throw new ConfigMergeError("That " + what + " was changed or removed elsewhere, so your change was not saved.");
  }
  if (i === -2) {
    throw new ConfigMergeError("Could not uniquely identify that " + what + "; refresh and try again.");
  }
  return i;
}
