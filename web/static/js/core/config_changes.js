/*
 * What differs between the applied config and the saved one, in plain language.
 *
 * Each change carries the steps that make it, as data, so it can be reverted one at a
 * time. A revert is an edit for saveConfigEdit, applied to fresh config: it touches only
 * the rows and values it names, so changes saved since it was listed survive. It refuses
 * rather than overwrites when one of those rows has moved on.
 *
 * Every differing value ends up in some change, including settings with no label below.
 * A list that left something out would be a review that hides what Apply is about to do.
 */
import { ConfigMergeError, routeIdentity } from "./config_save.js";
import { routeProtoPlainText, tunnelHostOnly } from "./net.js";

function isEmptyValue(v) {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && Object.keys(v).length === 0;
}

/** Sorted keys and no empty values: the API omits `disabled: false`, a client may send it. */
function stripEmpty(v) {
  if (Array.isArray(v)) return v.map(stripEmpty);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const s = stripEmpty(v[k]);
    if (!isEmptyValue(s)) out[k] = s;
  }
  return out;
}

function canonical(v) {
  const s = stripEmpty(v);
  return isEmptyValue(s) ? "null" : JSON.stringify(s);
}

const same = (a, b) => canonical(a) === canonical(b);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const countOf = (rows, row) => rows.filter((r) => same(r, row)).length;

function getPath(obj, path) {
  return path.reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const parent = path.slice(0, -1).reduce((o, k) => (o[k] = o[k] || {}), obj);
  const last = path[path.length - 1];
  if (value === undefined) delete parent[last];
  else parent[last] = value;
}

function listAt(obj, path) {
  const rows = getPath(obj, path);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Pairs rows across two lists. Identical rows first, then each key in turn, so an edited
 * row reads as one change rather than a removal and an addition.
 */
function matchRows(before, after, keys) {
  const freeBefore = new Set(before.keys());
  const freeAfter = new Set(after.keys());
  const pass = (keyOf, out) => {
    for (const b of freeBefore) {
      const key = keyOf(before[b], b);
      if (key === null || key === "") continue;
      for (const a of freeAfter) {
        if (keyOf(after[a], a) === key) {
          out.push([b, a]);
          freeBefore.delete(b);
          freeAfter.delete(a);
          break;
        }
      }
    }
    return out;
  };
  const kept = pass(canonical, []);
  const edited = [];
  for (const key of keys) pass(key, edited);
  return { kept, edited, removed: [...freeBefore], added: [...freeAfter] };
}

function protoLabel(proto) {
  return routeProtoPlainText(proto).toUpperCase().replace(", ", "+");
}

function joined(v) {
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

function formatValue(v) {
  return isEmptyValue(v) ? "none" : joined(v);
}

/** Tunnel host to peer name, from both configs: a route's peer may exist on only one side. */
function peerNames(applied, saved) {
  const names = new Map();
  for (const cfg of [applied, saved]) {
    for (const p of cfg.peers || []) {
      const host = tunnelHostOnly(p.tunnel_ip);
      const name = String(p.name || "").trim();
      if (host && name) names.set(host, name);
    }
  }
  return names;
}

function routeTarget(host, names) {
  const ip = String(host || "").trim();
  return names.get(ip) || ip || "—";
}

function routePorts(r) {
  return protoLabel(r.proto) + " " + (joined(r.ports) || "—");
}

function peerLabel(p) {
  return String(p.name || "").trim() || tunnelHostOnly(p.tunnel_ip) || String(p.public_key || "").slice(0, 8) || "—";
}

function inboundLabel(r) {
  const port = String(r.dport || "").replace(/[{}]/g, "").trim() || "—";
  const note = String(r.note || "").trim();
  return protoLabel(r.proto) + " " + port + (note ? " (" + note + ")" : "");
}

const routePortsKey = (r) => joined(r.ports);
const routeTargetKey = (r) => String(r.target_ip || "").trim();
const atSameIndex = (_, i) => i;

/** The lists shown row by row. `fields` label what an edit changed; `format: null` hides the values. */
function rowLists(names) {
  return [
    {
      path: ["peers"],
      what: "peer",
      plural: "peers",
      label: peerLabel,
      // Not by position: a new key with a new name and address is a different peer.
      keys: [(p) => String(p.public_key || ""), (p) => String(p.name || "").trim(), (p) => tunnelHostOnly(p.tunnel_ip)],
      fields: {
        name: { label: "name" },
        tunnel_ip: { label: "tunnel IP" },
        public_key: { label: "public key", format: null },
      },
    },
    {
      path: ["forwarding", "routes"],
      what: "route",
      plural: "routes",
      label: (r) => routePorts(r) + " → " + routeTarget(r.target_ip, names),
      keys: [routeIdentity, routePortsKey, routeTargetKey, atSameIndex],
      fields: {
        proto: { label: "protocol", format: protoLabel },
        ports: { label: "ports" },
        target_ip: { label: "target", format: (v) => routeTarget(v, names) },
        source_allow_cidrs: { label: "allowed sources" },
        source_deny_cidrs: { label: "blocked sources" },
        port_maps: { label: "port mapping", format: null },
        geo_mode: { label: "geo mode" },
        geo_countries: { label: "geo countries" },
        rate_limit: { label: "rate limit", format: null },
      },
    },
    {
      path: ["input_allows"],
      what: "inbound rule",
      plural: "inbound rules",
      label: inboundLabel,
      keys: [(r) => protoLabel(r.proto) + " " + r.dport, (r) => String(r.dport || ""), (r) => String(r.note || "").trim(), atSameIndex],
      fields: {
        proto: { label: "protocol", format: protoLabel },
        dport: { label: "port" },
        note: { label: "note" },
      },
    },
  ];
}

function fieldChanges(before, after, fields) {
  const out = [];
  for (const k of new Set([...Object.keys(fields), ...Object.keys(before), ...Object.keys(after)])) {
    if (k === "disabled" || same(before[k], after[k])) continue;
    const field = fields[k] || { label: k.replace(/_/g, " ") };
    if (field.format === null) {
      out.push(field.label + " changed");
    } else {
      const format = field.format || formatValue;
      const show = (v) => (isEmptyValue(v) ? "none" : format(v));
      out.push(field.label + " " + show(before[k]) + " to " + show(after[k]));
    }
  }
  if (!!before.disabled !== !!after.disabled) out.push(after.disabled ? "now disabled" : "now enabled");
  return out;
}

function editedRowText(list, before, after) {
  const onlyToggled = !!before.disabled !== !!after.disabled && same({ ...before, disabled: 0 }, { ...after, disabled: 0 });
  if (onlyToggled) return (after.disabled ? "Disabled " : "Enabled ") + list.what + " " + list.label(after);
  if (list.what === "peer" && same({ ...before, name: "" }, { ...after, name: "" })) {
    return "Renamed peer " + list.label(before) + " to " + list.label(after);
  }
  return "Changed " + list.what + " " + list.label(before) + ": " + fieldChanges(before, after, list.fields).join("; ");
}

function rowStep(path, before, after, beforeAt, afterAt, beforeRows, afterRows) {
  return { kind: "row", path, before, after, beforeAt, afterAt, beforeRows, afterRows };
}

function orderChange(path, plural, before, after, kept) {
  const inOrder = [...kept].sort((x, y) => x[0] - y[0]);
  if (inOrder.every(([, a], i) => i === 0 || inOrder[i - 1][1] < a)) return null;
  const byAfter = [...kept].sort((x, y) => x[1] - y[1]);
  return {
    text: "Changed the order of " + plural,
    steps: [{ kind: "order", path, before: inOrder.map(([b]) => before[b]), after: byAfter.map(([, a]) => after[a]) }],
  };
}

function describeRowList(list, applied, saved) {
  const before = listAt(applied, list.path);
  const after = listAt(saved, list.path);
  const { kept, edited, removed, added } = matchRows(before, after, list.keys);
  const step = (b, a) => rowStep(list.path, before[b], after[a], b, a, before, after);
  const changes = [];
  for (const b of removed) {
    changes.push({ text: "Removed " + list.what + " " + list.label(before[b]), steps: [step(b, -1)], row: { before: before[b] } });
  }
  for (const [b, a] of edited) {
    changes.push({ text: editedRowText(list, before[b], after[a]), steps: [step(b, a)], row: { before: before[b], after: after[a] } });
  }
  for (const a of added) {
    const suffix = after[a].disabled ? " (disabled)" : "";
    changes.push({ text: "Added " + list.what + " " + list.label(after[a]) + suffix, steps: [step(-1, a)], row: { after: after[a] } });
  }
  const order = orderChange(list.path, list.plural, before, after, kept);
  if (order) changes.push(order);
  return changes;
}

/**
 * A peer can only be removed or disabled along with its routes, so the Peers page turns
 * them off in one action. Listing them apart would offer a Revert the API must refuse: a
 * route back on with no peer behind it. They read and revert as the one action they were.
 */
function foldCascades(peerChanges, routeChanges) {
  for (const change of peerChanges) {
    const { row } = change;
    if (!row || !row.before || row.before.disabled || (row.after && !row.after.disabled)) continue;
    const host = tunnelHostOnly(row.before.tunnel_ip);
    const cascaded = routeChanges.filter(({ row: r }) => {
      if (!r || !r.before || !r.after || r.before.disabled || !r.after.disabled) return false;
      return same({ ...r.before, disabled: 0 }, { ...r.after, disabled: 0 }) && routeTargetKey(r.before) === host;
    });
    if (!host || !cascaded.length) continue;
    const ports = cascaded.map(({ row: r }) => routePorts(r.before)).join(", ");
    change.text += " and disabled " + (cascaded.length === 1 ? "route " : cascaded.length + " routes: ") + ports;
    for (const c of cascaded) {
      change.steps.push(...c.steps);
      routeChanges.splice(routeChanges.indexOf(c), 1);
    }
  }
}

const SETTING_LABELS = {
  "wireguard.interface": "WireGuard interface",
  "wireguard.listen_port": "WireGuard listen port",
  "wireguard.private_key_file": "WireGuard private key file",
  "wireguard.address": "WireGuard address",
  "network.public_interface": "public interface",
  "network.admin_tcp_ports": "admin TCP ports",
  "network.forward_allow_docker_bridges": "Docker bridge forwarding",
  "network.forward_extra_local_cidrs": "extra local CIDRs",
  "forwarding.source_deny_cidrs": "blocked sources",
  "forwarding.maintenance_mode": "maintenance mode",
  "forwarding.rate_limit.tcp_syn_per_second": "TCP SYN rate limit",
  "forwarding.rate_limit.max_conn_per_ip": "connections per IP limit",
  "forwarding.rate_limit.udp_per_second": "UDP rate limit",
  "geo.enabled": "geoblocking",
  "geo.mode": "geoblocking mode",
  "geo.set_name": "geoblocking set name",
  "geo.countries": "geoblocking countries",
  "geo.zone_dir": "geoblocking zone directory",
  "geo.apply_to_input_allows": "geoblocking on inbound rules",
  "geo.break_glass_cidrs": "break-glass",
  "crowdsec.enabled": "CrowdSec",
  "apply.confirm": "revert Apply unless confirmed",
  "apply.confirm_timeout_seconds": "seconds to confirm an Apply",
  "auto_pause.failures_to_pause": "failures to auto-pause",
  "auto_pause.successes_to_resume": "successes to auto-resume",
  "auto_pause.interval": "auto-pause interval",
  "auto_pause.icmp_fallback": "auto-pause ICMP fallback",
};

function settingLabel(path) {
  return SETTING_LABELS[path.join(".")] || path.join(" ").replace(/_/g, " ");
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isScalarList = (v) => isEmptyValue(v) || (Array.isArray(v) && v.every((x) => !x || typeof x !== "object"));

function describeScalarList(path, label, applied, saved) {
  const before = listAt(applied, path);
  const after = listAt(saved, path);
  const { kept, removed, added } = matchRows(before, after, []);
  const changes = [];
  for (const b of removed) {
    changes.push({ text: "Removed " + before[b] + " from " + label, steps: [rowStep(path, before[b], undefined, b, -1, before, after)] });
  }
  for (const a of added) {
    changes.push({ text: "Added " + after[a] + " to " + label, steps: [rowStep(path, undefined, after[a], -1, a, before, after)] });
  }
  const order = orderChange(path, label, before, after, kept);
  if (order) changes.push(order);
  return changes;
}

function describeValue(path, before, after) {
  const label = settingLabel(path);
  let text;
  if (typeof before === "boolean" || typeof after === "boolean") {
    text = (after ? "Turned on " : "Turned off ") + label;
  } else if (Array.isArray(before) || Array.isArray(after) || isPlainObject(before) || isPlainObject(after)) {
    text = "Changed " + label;
  } else {
    const show = (v) => (isEmptyValue(v) ? "not set" : String(v));
    text = "Changed " + label + " from " + show(before) + " to " + show(after);
  }
  return { text, steps: [{ kind: "value", path, before, after }] };
}

/** Everything outside the row lists, walked down to single values so each reverts alone. */
function describeSettings(applied, saved, rowPaths, path = []) {
  const before = path.length ? getPath(applied, path) : applied;
  const after = path.length ? getPath(saved, path) : saved;
  if (rowPaths.has(path.join(".")) || same(before, after)) return [];
  if ((isPlainObject(before) || isEmptyValue(before)) && (isPlainObject(after) || isEmptyValue(after)) && (isPlainObject(before) || isPlainObject(after))) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...keys].flatMap((k) => describeSettings(applied, saved, rowPaths, [...path, k]));
  }
  if (isScalarList(before) && isScalarList(after)) return describeScalarList(path, settingLabel(path), applied, saved);
  return [describeValue(path, before, after)];
}

/** The changes that turn `applied` into `saved`, in reading order: peers, routes, rules, settings. */
export function describeConfigChanges(applied, saved) {
  const lists = rowLists(peerNames(applied, saved));
  const [peers, routes, inbound] = lists.map((list) => describeRowList(list, applied, saved));
  foldCascades(peers, routes);
  const rowPaths = new Set(lists.map((list) => list.path.join(".")));
  return [...peers, ...routes, ...inbound, ...describeSettings(applied, saved, rowPaths)];
}

function staleError() {
  return new ConfigMergeError("That change was edited elsewhere after it was listed, so it was not reverted.");
}

function moveRow(draft, step, have, want, wantAt, wantRows) {
  if (!Array.isArray(getPath(draft, step.path))) setPath(draft, step.path, []);
  const rows = getPath(draft, step.path);
  if (have === undefined) {
    // Compare counts, not presence: a surviving twin does not mean this row came back.
    if (countOf(rows, want) >= countOf(wantRows, want)) return false;
    if (want.public_key && rows.some((r) => r.public_key === want.public_key)) {
      throw new ConfigMergeError((want.name || "That peer") + " is already back in the config with other settings, so it was not restored.");
    }
    rows.splice(Math.min(wantAt, rows.length), 0, clone(want));
    return true;
  }
  if (want === undefined) {
    if (countOf(rows, have) <= countOf(wantRows, have)) return false;
    rows.splice(rows.findIndex((r) => same(r, have)), 1);
    return true;
  }
  const i = rows.findIndex((r) => same(r, have));
  if (i !== -1) {
    rows[i] = clone(want);
    return true;
  }
  if (rows.some((r) => same(r, want))) return false;
  throw staleError();
}

/** Puts the rows named by `wanted` in that order, in the slots they occupy. Others stay put. */
function setRowOrder(rows, wanted) {
  const unclaimed = rows.map(canonical);
  const order = [];
  const slots = [];
  for (const row of wanted) {
    const i = unclaimed.indexOf(canonical(row));
    if (i === -1) continue;
    unclaimed[i] = null;
    order.push(row);
    slots.push(i);
  }
  slots.sort((a, b) => a - b);
  let moved = false;
  slots.forEach((slot, n) => {
    if (!same(rows[slot], order[n])) moved = true;
    rows[slot] = clone(order[n]);
  });
  return moved;
}

function applyStep(draft, step, toApplied) {
  const have = toApplied ? step.after : step.before;
  const want = toApplied ? step.before : step.after;
  if (step.kind === "value") {
    const cur = getPath(draft, step.path);
    if (same(cur, want)) return false;
    if (!same(cur, have)) throw staleError();
    setPath(draft, step.path, clone(want));
    return true;
  }
  if (step.kind === "order") {
    return setRowOrder(listAt(draft, step.path), want);
  }
  return moveRow(
    draft,
    step,
    have,
    want,
    toApplied ? step.beforeAt : step.afterAt,
    toApplied ? step.beforeRows : step.afterRows
  );
}

function applyChange(draft, change, toApplied) {
  let changed = false;
  for (const step of change.steps) {
    if (applyStep(draft, step, toApplied)) changed = true;
  }
  return changed;
}

/** Edit for saveConfigEdit: takes this one change back out. False when it is already gone. */
export function revertChange(draft, change) {
  return applyChange(draft, change, true);
}

/** Edit for saveConfigEdit: puts a reverted change back, for the toast's Undo. */
export function reapplyChange(draft, change) {
  return applyChange(draft, change, false);
}
