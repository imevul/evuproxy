export function ipv4ToInt(s) {
  const p = String(s || "")
    .trim()
    .split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const x = +p[i];
    if (x !== (x | 0) || x < 0 || x > 255) return null;
    n = ((n << 8) | x) >>> 0;
  }
  return n;
}

export function intToIpv4(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function validLinuxIfaceName(name) {
  const s = String(name || "").trim();
  return /^[a-zA-Z0-9._-]{1,15}$/.test(s) ? s : "";
}

export function parseIPv4CIDR(cidr) {
  const m = String(cidr || "")
    .trim()
    .match(/^([\d.]+)\/(\d+)$/);
  if (!m) return null;
  const prefix = +m[2];
  if (prefix < 0 || prefix > 32) return null;
  const ip = ipv4ToInt(m[1]);
  if (ip === null) return null;
  if (prefix === 32) {
    return { network: ip, broadcast: ip, prefix, mask: 0xffffffff };
  }
  // JS shifts mask to 5 bits, so `<< 32` is `<< 0` — handle /0 explicitly.
  if (prefix === 0) {
    return { network: 0, broadcast: 0xffffffff, prefix, mask: 0 };
  }
  const mask = ((-1) << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast, prefix, mask };
}

export function ipInCidr(ipInt, parsed) {
  return ipInt >= parsed.network && ipInt <= parsed.broadcast;
}

export function tunnelHostOnly(tunnelIp) {
  const s = String(tunnelIp || "").trim();
  const m = s.match(/^([\d.]+)/);
  return m ? m[1] : "";
}

/** Tunnel address without /prefix (for clipboard). */
export function tunnelIpWithoutSuffix(tunnelIp) {
  const s = String(tunnelIp ?? "").trim();
  if (!s) return "";
  const i = s.indexOf("/");
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

export function tunnelToHost(tip) {
  tip = String(tip || "").trim();
  const m = tip.match(/^([\d.]+)(?:\/\d+)?$/);
  return m ? m[1] : "";
}

export function parsePortsList(s) {
  return s
    .split(/[,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseSourceAllowListInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** True when ip (IPv4) equals or falls inside any bare address / CIDR in entries. */
export function ipv4CoveredByCIDRList(ip, entries) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  for (const raw of entries || []) {
    const s = String(raw || "").trim();
    if (!s) continue;
    if (s.includes("/")) {
      const parsed = parseIPv4CIDR(s);
      if (parsed && ipInCidr(ipInt, parsed)) return true;
      continue;
    }
    const other = ipv4ToInt(s);
    if (other !== null && other === ipInt) return true;
  }
  return false;
}

export function routeProtoPlainText(p) {
  const raw = String(p || "").trim();
  if (!raw) return "—";
  const s = raw.toLowerCase();
  if (s === "both") return "tcp, udp";
  const parts = s.split(/[,+\s]+/).map((x) => x.trim()).filter(Boolean);
  const tcp = s === "tcp" || parts.includes("tcp");
  const udp = s === "udp" || parts.includes("udp");
  if (tcp && udp) return "tcp, udp";
  if (tcp) return "tcp";
  if (udp) return "udp";
  return raw;
}
