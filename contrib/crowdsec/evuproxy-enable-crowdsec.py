#!/usr/bin/env python3
"""Enable crowdsec.enabled in EvuProxy config.yaml (stdlib only). Used by install.sh."""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path


def _parse_enabled_token(token: str) -> bool | None:
    """Match Go yaml.v3 bool parsing: true/True; quoted strings are not bool true."""
    raw = token.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return None
    low = raw.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    return None


def is_enabled(text: str) -> bool:
    m = re.search(
        r"^crowdsec:\s*\n(?:[ \t#].*\n)*?[ \t]+enabled:\s*(\S+)",
        text,
        re.MULTILINE,
    )
    if not m:
        return False
    return _parse_enabled_token(m.group(1)) is True


def enable(text: str) -> str:
    if is_enabled(text):
        return text

    # Uncomment a commented example block if present.
    uncommented = re.sub(
        r"^# crowdsec:\s*\n(?:#   .*\n)*?#   enabled:\s*\S+\s*\n",
        "crowdsec:\n  enabled: true\n\n",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if uncommented != text and is_enabled(uncommented):
        return uncommented
    text = uncommented

    if re.search(r"^crowdsec:", text, re.MULTILINE):
        lines = text.splitlines(keepends=True)
        out: list[str] = []
        in_block = False
        enabled_written = False
        for line in lines:
            if line.startswith("crowdsec:"):
                in_block = True
                enabled_written = False
                out.append(line)
                continue
            if in_block:
                if line and not line[0].isspace() and not line.startswith("#"):
                    if not enabled_written:
                        out.append("  enabled: true\n")
                    in_block = False
                    out.append(line)
                    continue
                if re.match(r"[ \t]+enabled:\s*", line):
                    out.append("  enabled: true\n")
                    enabled_written = True
                    continue
                out.append(line)
                continue
            out.append(line)
        if in_block and not enabled_written:
            out.append("  enabled: true\n")
        result = "".join(out)
        if not result.endswith("\n"):
            result += "\n"
        return result

    suffix = "\n" if text.endswith("\n") else "\n\n"
    return text.rstrip() + suffix + "crowdsec:\n  enabled: true\n"


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("--check", "--enable"):
        print("usage: evuproxy-enable-crowdsec.py --check|--enable CONFIG.yaml", file=sys.stderr)
        return 2
    path = Path(sys.argv[2])
    if not path.is_file():
        print(f"config not found: {path}", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")
    if sys.argv[1] == "--check":
        return 0 if is_enabled(text) else 1
    new_text = enable(text)
    if new_text == text:
        return 0
    shutil.copy2(path, path.with_name(path.name + ".bak.crowdsec-install"))
    path.write_text(new_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
