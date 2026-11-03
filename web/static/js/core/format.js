import { escapeHtml } from "./dom.js";

/*
 * Wording for times, byte counts and host events. Numbers and dates follow the
 * browser's locale; relative phrases stay English, like the rest of the UI.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const relativeFormat = new Intl.RelativeTimeFormat("en", { style: "narrow" });
const absoluteFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const hoverFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "long" });
const countFormat = new Intl.NumberFormat();
const byteFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** "2h ago", or the absolute date once it is more than a week old. */
export function formatRelativeTime(date, now = Date.now()) {
  const age = now - date.getTime();
  if (age >= WEEK_MS) return absoluteFormat.format(date);
  if (age < MINUTE_MS) return "just now";
  if (age < HOUR_MS) return relativeFormat.format(-Math.floor(age / MINUTE_MS), "minute");
  if (age < DAY_MS) return relativeFormat.format(-Math.floor(age / HOUR_MS), "hour");
  return relativeFormat.format(-Math.floor(age / DAY_MS), "day");
}

/** A `<time>` reading relative, absolute on hover. Text it cannot parse is shown as it came. */
export function timeHtml(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return escapeHtml(String(value ?? ""));
  return `<time datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(hoverFormat.format(date))}">${escapeHtml(formatRelativeTime(date))}</time>`;
}

/** `5546` → `5.4 KiB`. Missing values read as a dash, not as zero. */
export function formatBytes(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return "—";
  let size = n;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  return byteFormat.format(size) + " " + BYTE_UNITS[unit];
}

export function formatCount(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return "—";
  return countFormat.format(n);
}

const EVENT_LABELS = {
  reload_started: "Apply started",
  reload_ok: "Applied config",
  reload_failed: "Apply failed",
  apply_confirmed: "Kept applied config",
  apply_reverted: "Reverted Apply",
  apply_revert_failed: "Revert failed",
  config_put_ok: "Saved config",
  config_put_failed: "Save failed",
  config_discard_ok: "Discarded pending changes",
  config_discard_failed: "Discard failed",
  config_restore_previous_ok: "Restored previous config",
  config_restore_previous_failed: "Restore of previous config failed",
  update_geo_ok: "Updated geo lists",
  update_geo_failed: "Geo list update failed",
  backup_ok: "Created backup",
  backup_failed: "Backup failed",
  restore_ok: "Restored backup",
  restore_failed: "Backup restore failed",
  route_auto_paused: "Route auto-paused",
  route_auto_resumed: "Route auto-resumed",
};

/** Plain wording for an event code. The CSV export keeps the raw codes. */
export function eventLabel(code) {
  const raw = String(code || "");
  if (EVENT_LABELS[raw]) return EVENT_LABELS[raw];
  const words = raw.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An event's detail to show. A bare "reload" is only the API's name for an Apply. */
export function eventDetail(e) {
  return e.detail === "reload" ? "" : e.detail || "";
}

/** Why an Apply failed. Other errors, such as a busy or unreachable API, read as sent. */
export function applyErrorText(e) {
  const text = String(e.message || e);
  return text === "reload failed" ? "Apply failed" : text;
}

/** The toast for a POST /update-geo answer. With confirm on, it leaves unapplied geo changes out. */
export function geoUpdatedMessage(res) {
  return res && res.geo_changes_held_back
    ? "Geo lists updated. Your unapplied geo changes go live when you Apply."
    : "Geo lists updated on host";
}

/** What last loaded the geo lists. The API records an Apply as "reload". */
export function geoSourceLabel(source) {
  return source === "reload" ? "Apply" : source;
}
