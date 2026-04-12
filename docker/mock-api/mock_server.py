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

MOCK_CONFIG = {
    "wireguard": {
        "interface": "evuproxy0",
        "listen_port": 51830,
        "private_key_file": "/etc/evuproxy/wg-private.key",
        "address": "10.100.0.1/24",
    },
    "network": {"public_interface": "eth0"},
    "forwarding": {"routes": []},
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


def _disk_config_sha() -> str:
    blob = json.dumps(MOCK_CONFIG, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def _ensure_mock_apply_bootstrap() -> None:
    global MOCK_APPLIED_SHA
    if MOCK_APPLIED_SHA is None:
        MOCK_APPLIED_SHA = _disk_config_sha()


def _mock_nft_preview() -> str:
    lines = ["# Mock nftables preview (from saved JSON config)", ""]
    for r in MOCK_CONFIG.get("forwarding", {}).get("routes") or []:
        lines.append(
            "# %s %s -> %s"
            % (r.get("proto"), r.get("ports"), r.get("target_ip"))
        )
    lines.append("")
    lines.append("# (Real server returns full `nft` rules from internal/gen.)")
    return "\n".join(lines)


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
            return self._send_json(
                200,
                {
                    "pending": pending,
                    "current_config_sha256": disk,
                    "applied_config_sha256": MOCK_APPLIED_SHA,
                    "nftables": _mock_nft_preview(),
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
        MOCK_CONFIG = body
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
        ):
            return self._send_json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)
        if not _auth_ok(self):
            return self._send_json(401, {"error": "unauthorized"})
        if path == "/api/v1/reload":
            global MOCK_APPLIED_SHA
            MOCK_APPLIED_SHA = _disk_config_sha()
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
