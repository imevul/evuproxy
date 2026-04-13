#!/usr/bin/env python3
"""Minimal EvuProxy API stub for local UI testing (no host network or nftables)."""

import copy
import hashlib
import ipaddress
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = os.environ.get("MOCK_API_TOKEN", "dev")
PORT = int(os.environ.get("PORT", "9847"))
DEFAULT_PEER_TUNNEL_SUBNET_CIDR = "10.100.0.0/24"

# Last "applied" snapshot (simulates generated/nftables.nft + apply state before current edits).
MOCK_CONFIG_BASELINE = {
    "wireguard": {
        "interface": "evuproxy0",
        "listen_port": 51829,
        "private_key_file": "/etc/evuproxy/wg-private.key",
        "address": "10.100.0.1/24",
    },
    "network": {"public_interface": "eth0"},
    "forwarding": {"routes": []},
    "geo": {
        "enabled": False,
        "mode": "allow",
        "set_name": "geo_v4",
        "countries": [],
        "zone_dir": "/etc/evuproxy/geo-zones",
    },
    "input_allows": [
        {"proto": "tcp", "dport": "22", "note": "SSH"},
        {"proto": "tcp", "dport": "{ 80, 443 }", "note": "HTTP(S)"},
    ],
    "peers": [],
}

# In-memory "saved" config (what GET /config returns) — differs from baseline until POST /reload.
MOCK_CONFIG = {
    "wireguard": {
        "interface": "evuproxy0",
        "listen_port": 51830,
        "private_key_file": "/etc/evuproxy/wg-private.key",
        "address": "10.100.0.1/24",
    },
    "network": {"public_interface": "eth0"},
    "forwarding": {
        "routes": [
            {
                "proto": "tcp",
                "ports": ["25565"],
                "target_ip": "10.100.0.10",
                "disabled": False,
            }
        ]
    },
    "geo": {
        "enabled": True,
        "mode": "allow",
        "set_name": "geo_v4",
        "countries": ["se", "no"],
        "zone_dir": "/etc/evuproxy/geo-zones",
    },
    "input_allows": [
        {"proto": "tcp", "dport": "22", "note": "SSH"},
        {"proto": "tcp", "dport": "{ 80, 443 }", "note": "HTTP(S)"},
        {"proto": "tcp", "dport": "9080", "note": "EvuProxy admin UI (Docker)"},
    ],
    "peers": [],
}

MOCK_APPLIED_SHA: str | None = None

# Last distinct applied config (updated on POST /reload); .bak.1 … .bak.5 in MOCK_BAK_SLOTS[0..4].
MOCK_BAK: dict | None = None
MOCK_BAK_SLOTS: list[dict | None] = [None, None, None, None, None]

MOCK_PREFS: dict = {
    "peer_tunnel_subnet_cidr": "",
    "wireguard_server_endpoint": "",
}


def _normalize_prefs(d: dict) -> dict:
    """Match apply.LoadUIPreferences: default tunnel subnet when unset."""
    out = copy.deepcopy(d)
    peer = (out.get("peer_tunnel_subnet_cidr") or "").strip()
    if not peer:
        peer = DEFAULT_PEER_TUNNEL_SUBNET_CIDR
    out["peer_tunnel_subnet_cidr"] = peer
    out["wireguard_server_endpoint"] = (out.get("wireguard_server_endpoint") or "").strip()
    return out


def _config_sha(cfg: dict) -> str:
    blob = json.dumps(cfg, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def _disk_config_sha() -> str:
    return _config_sha(MOCK_CONFIG)


def _mock_record_applied_snapshot() -> None:
    """Match RecordAppliedConfigSnapshot: rotate .bak chain when applied config differs from .bak."""
    global MOCK_BAK, MOCK_BAK_SLOTS
    cur = copy.deepcopy(MOCK_CONFIG)
    if MOCK_BAK is None:
        MOCK_BAK = cur
        return
    if _config_sha(cur) == _config_sha(MOCK_BAK):
        return
    for i in range(4, 0, -1):
        MOCK_BAK_SLOTS[i] = (
            copy.deepcopy(MOCK_BAK_SLOTS[i - 1])
            if MOCK_BAK_SLOTS[i - 1] is not None
            else None
        )
    MOCK_BAK_SLOTS[0] = copy.deepcopy(MOCK_BAK)
    MOCK_BAK = cur


def _baseline_config_sha() -> str:
    blob = json.dumps(MOCK_CONFIG_BASELINE, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def _ensure_mock_apply_bootstrap() -> None:
    """Pretend last successful apply matched MOCK_CONFIG_BASELINE (pending until reload)."""
    global MOCK_APPLIED_SHA
    if MOCK_APPLIED_SHA is None:
        MOCK_APPLIED_SHA = _baseline_config_sha()


def _format_port_set(ports: list) -> str:
    parts = [str(p).strip() for p in (ports or []) if str(p).strip()]
    if not parts:
        return ""
    return "{ " + ", ".join(parts) + " }"


def _route_protocols(proto: str | None) -> list[str]:
    p = (proto or "tcp").lower().strip()
    if p in ("both", "tcp+udp"):
        return ["tcp", "udp"]
    if p == "udp":
        return ["udp"]
    return ["tcp"]


def _formatted_routes(cfg: dict) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    for r in cfg.get("forwarding", {}).get("routes") or []:
        if r.get("disabled"):
            continue
        expr = _format_port_set(r.get("ports") or [])
        if not expr:
            continue
        target = (r.get("target_ip") or "").strip()
        if not target:
            continue
        for pr in _route_protocols(r.get("proto")):
            out.append((pr, expr, target))
    return out


def _uniq_sorted_targets(routes: list[tuple[str, str, str]]) -> list[str]:
    s = sorted({t for _, _, t in routes})
    return s


def _nft_from_config(cfg: dict) -> str:
    """Subset of internal/gen/nftables.go output — enough for a realistic mock diff."""
    lines: list[str] = [
        "# Generated by evuproxy — do not edit. Regenerate with: evuproxy reload",
        "# Mock API: shaped like internal/gen/nftables.go (dev preview only).",
        "",
    ]
    pub = cfg["network"]["public_interface"]
    wg = cfg["wireguard"]["interface"]
    wg_port = int(cfg["wireguard"]["listen_port"])
    geo = cfg.get("geo") or {}
    geo_enabled = bool(geo.get("enabled"))
    geo_mode = (geo.get("mode") or "allow").lower().strip()
    block_listed = geo_enabled and geo_mode == "block"
    geo_set = (geo.get("set_name") or "geo_v4").strip() or "geo_v4"
    routes = _formatted_routes(cfg)

    lines.append("table inet evuproxy {")
    if geo_enabled:
        lines.extend(
            [
                "    set %s {" % geo_set,
                "        type ipv4_addr",
                "        flags interval",
                "        auto-merge",
                "    }",
                "",
            ]
        )

    lines.extend(
        [
            "    chain input {",
            "        type filter hook input priority 0; policy drop;",
            "",
            "        ct state established,related accept",
            '        iif "lo" accept',
            "",
        ]
    )
    for a in cfg.get("input_allows") or []:
        if a.get("disabled"):
            continue
        p = (a.get("proto") or "").lower().strip()
        d = (a.get("dport") or "").strip()
        if p in ("tcp", "udp") and d:
            lines.append("        %s dport %s accept" % (p, d))
    lines.append("        udp dport %d accept" % wg_port)

    for pr, port_expr, _target in routes:
        if not geo_enabled:
            lines.append("        %s dport %s accept" % (pr, port_expr))
        elif block_listed:
            lines.append(
                "        ip saddr @%s %s dport %s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop"
                % (geo_set, pr, port_expr)
            )
            lines.append("        %s dport %s accept" % (pr, port_expr))
        else:
            lines.append(
                "        ip saddr @%s %s dport %s accept" % (geo_set, pr, port_expr)
            )
            lines.append(
                "        %s dport %s ip saddr != @%s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop"
                % (pr, port_expr, geo_set)
            )

    lines.extend(
        [
            "    }",
            "",
            "    chain forward {",
            "        type filter hook forward priority 0; policy drop;",
            "",
            "        ct state established,related accept",
        ]
    )
    for pr, port_expr, target in routes:
        lines.append(
            '        iifname "%s" oifname "%s" ip daddr %s %s dport %s accept'
            % (pub, wg, target, pr, port_expr)
        )
    lines.extend(
        [
            '        iifname "%s" oifname "%s" ct state established,related accept' % (wg, pub),
            '        limit rate 3/minute burst 5 packets log prefix "evuproxy-forward-drop: " drop',
            "    }",
            "}",
            "",
            "table ip evuproxy {",
        ]
    )
    if geo_enabled:
        lines.extend(
            [
                "    set %s {" % geo_set,
                "        type ipv4_addr",
                "        flags interval",
                "        auto-merge",
                "    }",
                "",
            ]
        )
    lines.extend(
        [
            "    chain prerouting {",
            "        type nat hook prerouting priority -100;",
        ]
    )
    for pr, port_expr, target in routes:
        if not geo_enabled:
            lines.append("        %s dport %s dnat to %s" % (pr, port_expr, target))
        elif block_listed:
            lines.append(
                "        ip saddr @%s %s dport %s drop" % (geo_set, pr, port_expr)
            )
            lines.append("        %s dport %s dnat to %s" % (pr, port_expr, target))
        else:
            lines.append(
                "        ip saddr @%s %s dport %s dnat to %s"
                % (geo_set, pr, port_expr, target)
            )

    lines.extend(
        [
            "    }",
            "",
            "    chain postrouting {",
            "        type nat hook postrouting priority 100;",
        ]
    )
    for t in _uniq_sorted_targets(routes):
        lines.append('        oifname "%s" ip daddr %s masquerade' % (wg, t))
    lines.extend(["    }", "}"])
    return "\n".join(lines) + "\n"


MOCK_STATS = {
    "wireguard_interface": "evuproxy0",
    "wireguard_peers": [],
    "nftables_counters": [],
}

MOCK_LOGS = [
    "2026-01-15T10:00:01+00:00 host kernel: evuproxy-geo-block: IN=eth0 OUT= MAC= SRC=198.51.100.2 DST=…",
    "2026-01-15T10:00:02+00:00 host kernel: evuproxy-forward-drop: IN=eth0 …",
]


def _overview_from_config(cfg: dict) -> dict:
    wg = cfg["wireguard"]
    routes = cfg["forwarding"].get("routes") or []
    peer_names = [p["name"] for p in cfg.get("peers", []) if not p.get("disabled")]
    o = {
        "wireguard_interface": wg["interface"],
        "wireguard_listen_port": wg["listen_port"],
        "public_interface": cfg["network"]["public_interface"],
        "forwarding_routes": routes,
        "geo_enabled": cfg["geo"]["enabled"],
        "geo_mode": (cfg["geo"].get("mode") or "allow"),
        "geo_countries": list(cfg["geo"].get("countries") or []),
        "peer_names": peer_names,
        "server_public_key": "aN1ZvFJyNFsFtXZjMKtQRGQB+YWY6NxcCX79QbRhP0k=",
        "tunnel_subnet": "10.100.0.0/24",
    }
    return o


def _auth_ok(handler: BaseHTTPRequestHandler) -> bool:
    if not TOKEN:
        return True
    auth = handler.headers.get("Authorization", "")
    tok = ""
    if auth.lower().startswith("bearer "):
        tok = auth[7:].strip()
    if not tok:
        tok = handler.headers.get("X-API-Token", "").strip()
    return tok == TOKEN


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print("%s - %s" % (self.address_string(), fmt % args))

    def _send_json(self, code: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self) -> object | None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode())
        except json.JSONDecodeError:
            return None

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if not _auth_ok(self):
            return self._send_json(401, {"error": "unauthorized"})
        if path == "/api/v1/status":
            return self._send_json(
                200,
                {"report": "mock: WireGuard + nftables status would appear here."},
            )
        if path == "/api/v1/overview":
            return self._send_json(200, _overview_from_config(MOCK_CONFIG))
        if path == "/api/v1/config":
            return self._send_json(200, copy.deepcopy(MOCK_CONFIG))
        if path == "/api/v1/metrics":
            return self._send_json(
                200,
                {
                    "forward_chain": "mock forward chain counters",
                    "input_chain": "mock input chain counters",
                },
            )
        if path == "/api/v1/stats":
            st = copy.deepcopy(MOCK_STATS)
            st["wireguard_interface"] = MOCK_CONFIG["wireguard"]["interface"]
            return self._send_json(200, st)
        if path == "/api/v1/pending":
            _ensure_mock_apply_bootstrap()
            disk = _disk_config_sha()
            pending = disk != MOCK_APPLIED_SHA
            discard_available = bool(
                MOCK_BAK is not None and _disk_config_sha() != _config_sha(MOCK_BAK)
            )
            restore_previous_applied_available = False
            if MOCK_BAK is not None:
                for slot in MOCK_BAK_SLOTS:
                    if slot is not None and _config_sha(slot) != _config_sha(MOCK_BAK):
                        restore_previous_applied_available = True
                        break
            return self._send_json(
                200,
                {
                    "pending": pending,
                    "current_config_sha256": disk,
                    "applied_config_sha256": MOCK_APPLIED_SHA,
                    "nftables": _nft_from_config(MOCK_CONFIG),
                    "nftables_baseline": _nft_from_config(MOCK_CONFIG_BASELINE),
                    "discard_available": discard_available,
                    "restore_previous_applied_available": restore_previous_applied_available,
                },
            )
        if path == "/api/v1/preferences":
            return self._send_json(200, _normalize_prefs(MOCK_PREFS))
        if path == "/api/v1/about":
            return self._send_json(
                200,
                {
                    "version": "mock",
                    "repo_url": "https://github.com/imevul/evuproxy",
                },
            )
        if path == "/api/v1/logs":
            return self._send_json(
                200,
                {"lines": list(MOCK_LOGS), "source": "mock"},
            )
        return self._send_json(404, {"error": "not found"})

    def do_PUT(self) -> None:
        path = self.path.split("?", 1)[0]
        if not _auth_ok(self):
            return self._send_json(401, {"error": "unauthorized"})
        if path == "/api/v1/preferences":
            body = self._read_json_body()
            if not isinstance(body, dict):
                return self._send_json(400, {"error": "invalid json body"})
            cidr = (body.get("peer_tunnel_subnet_cidr") or "").strip()
            if cidr:
                try:
                    ipaddress.ip_network(cidr, strict=False)
                except ValueError as e:
                    return self._send_json(
                        400, {"error": "invalid peer_tunnel_subnet_cidr: %s" % e}
                    )
            global MOCK_PREFS
            MOCK_PREFS = {
                "peer_tunnel_subnet_cidr": cidr,
                "wireguard_server_endpoint": (
                    body.get("wireguard_server_endpoint") or ""
                ).strip(),
            }
            return self._send_json(200, _normalize_prefs(MOCK_PREFS))
        if path != "/api/v1/config":
            return self._send_json(404, {"error": "not found"})
        body = self._read_json_body()
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "invalid json body"})
        global MOCK_CONFIG
        MOCK_CONFIG = copy.deepcopy(body)
        return self._send_json(
            200,
            {
                "result": "saved",
                "hint": "Review and apply from GET /api/v1/pending or POST /api/v1/reload",
            },
        )

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path not in (
            "/api/v1/reload",
            "/api/v1/update-geo",
            "/api/v1/backup",
            "/api/v1/restore",
            "/api/v1/config/discard",
            "/api/v1/config/restore-previous-applied",
        ):
            return self._send_json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)
        if not _auth_ok(self):
            return self._send_json(401, {"error": "unauthorized"})
        global MOCK_CONFIG, MOCK_APPLIED_SHA, MOCK_CONFIG_BASELINE
        if path == "/api/v1/config/discard":
            if MOCK_BAK is None:
                return self._send_json(
                    400, {"error": "could not discard pending changes"}
                )
            if _disk_config_sha() == _config_sha(MOCK_BAK):
                return self._send_json(
                    400, {"error": "could not discard pending changes"}
                )
            MOCK_CONFIG = copy.deepcopy(MOCK_BAK)
            return self._send_json(
                200,
                {
                    "result": "discarded",
                    "hint": "Review GET /api/v1/pending or POST /api/v1/reload",
                },
            )
        if path == "/api/v1/config/restore-previous-applied":
            if MOCK_BAK is None:
                return self._send_json(
                    400, {"error": "could not restore previous applied configuration"}
                )
            for slot in MOCK_BAK_SLOTS:
                if slot is not None and _config_sha(slot) != _config_sha(MOCK_BAK):
                    MOCK_CONFIG = copy.deepcopy(slot)
                    return self._send_json(
                        200,
                        {
                            "result": "restored",
                            "hint": "Review GET /api/v1/pending or POST /api/v1/reload",
                        },
                    )
            return self._send_json(
                400, {"error": "could not restore previous applied configuration"}
            )
        if path == "/api/v1/reload":
            MOCK_APPLIED_SHA = _disk_config_sha()
            MOCK_CONFIG_BASELINE = copy.deepcopy(MOCK_CONFIG)
            _mock_record_applied_snapshot()
            return self._send_json(200, {"result": "reloaded"})
        if path == "/api/v1/update-geo":
            return self._send_json(200, {"result": "geo_updated"})
        if path == "/api/v1/backup":
            return self._send_json(200, {"archive": "/var/backups/evuproxy-config.tgz"})
        return self._send_json(
            200,
            {"result": "restored", "hint": "run evuproxy reload"},
        )


if __name__ == "__main__":
    httpd = HTTPServer(("0.0.0.0", PORT), Handler)
    print("mock EvuProxy API on 0.0.0.0:%s (MOCK_API_TOKEN=%r)" % (PORT, TOKEN))
    httpd.serve_forever()
