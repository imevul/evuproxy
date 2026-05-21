#!/usr/bin/env python3
"""Tests for evuproxy-enable-crowdsec.py (stdlib unittest)."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "evuproxy_enable_crowdsec",
    _DIR / "evuproxy-enable-crowdsec.py",
)
_MOD = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
sys.modules[_SPEC.name] = _MOD
_SPEC.loader.exec_module(_MOD)

is_enabled = _MOD.is_enabled
enable = _MOD.enable


class TestIsEnabled(unittest.TestCase):
    def test_missing_block(self) -> None:
        self.assertFalse(is_enabled("wireguard:\n  interface: wg0\n"))

    def test_false(self) -> None:
        self.assertFalse(is_enabled("crowdsec:\n  enabled: false\n"))

    def test_true(self) -> None:
        self.assertTrue(is_enabled("crowdsec:\n  enabled: true\n"))

    def test_true_capitalized(self) -> None:
        self.assertTrue(is_enabled("crowdsec:\n  enabled: True\n"))

    def test_quoted_string_not_enabled(self) -> None:
        self.assertFalse(is_enabled('crowdsec:\n  enabled: "true"\n'))


class TestEnable(unittest.TestCase):
    def test_append_when_missing(self) -> None:
        out = enable("wireguard:\n  interface: wg0\n")
        self.assertTrue(is_enabled(out))
        self.assertIn("crowdsec:\n  enabled: true", out)

    def test_uncomment_example(self) -> None:
        text = "# crowdsec:\n#   enabled: false\n\nforwarding:\n  routes: []\n"
        out = enable(text)
        self.assertTrue(is_enabled(out))

    def test_idempotent_when_true(self) -> None:
        text = "crowdsec:\n  enabled: true\n"
        self.assertEqual(enable(text), text)

    def test_sets_false_to_true(self) -> None:
        text = "crowdsec:\n  enabled: false\n"
        out = enable(text)
        self.assertTrue(is_enabled(out))


if __name__ == "__main__":
    unittest.main()
