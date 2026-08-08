#!/usr/bin/env python3
"""Report same-specificity property conflicts across the split stylesheets.

The split moved rule blocks between files, which can silently reorder two rules
that declare the same property at the same specificity. Where those two rules
can match the same element, the winner changed. This flags every such pair so
they can be checked by hand.
"""
import re
import sys
from pathlib import Path

ORDER = [
    "tokens.css",
    "shell.css",
    "forms.css",
    "components.css",
    "features/overview.css",
    "features/topology.css",
    "features/geo.css",
    "features/pending.css",
    "features/logs.css",
    "features/peers.css",
    "features/routes.css",
]

BLOCK = re.compile(r"([^{}]+)\{([^{}]*)\}")


def specificity(sel: str):
    s = re.sub(r"::?[a-z-]+(\([^)]*\))?", "", sel)
    ids = len(re.findall(r"#[\w-]+", s))
    cls = len(re.findall(r"\.[\w-]+", s)) + len(re.findall(r"\[[^\]]+\]", s))
    els = len(re.findall(r"(?:^|[\s>+~])([a-z][\w-]*)", s))
    return (ids, cls, els)


def classes(sel: str):
    return frozenset(re.findall(r"\.([\w-]+)", sel))


def can_share_element(ca, cb):
    """True if some element could plausibly carry both selectors' classes.

    Covers subset pairs (.card / .card.foo) and BEM base/modifier pairs
    (.hint / .hint--tight), which are routinely applied together.
    """
    if ca <= cb or cb <= ca:
        return True
    for x in ca:
        for y in cb:
            if x.startswith(f"{y}--") or y.startswith(f"{x}--"):
                return True
    return False


def main(root: Path):
    rules = []
    for name in ORDER:
        text = (root / name).read_text()
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        # Drop at-rule wrappers so nested blocks are still seen.
        for sels, body in BLOCK.findall(text):
            sels = sels.strip()
            if not sels or sels.startswith("@") or sels.endswith(")"):
                continue
            for sel in sels.split(","):
                sel = sel.strip()
                if not sel:
                    continue
                props = {
                    m.group(1).strip()
                    for m in re.finditer(r"([-\w]+)\s*:", body)
                }
                rules.append((name, sel, specificity(sel), props, classes(sel)))

    conflicts = []
    for i, (fa, sa, spa, pa, ca) in enumerate(rules):
        for fb, sb, spb, pb, cb in rules[i + 1 :]:
            if fa == fb or spa != spb or sa == sb:
                continue
            if not (ca and cb and can_share_element(ca, cb)):
                continue
            shared = pa & pb
            if shared:
                conflicts.append((fa, sa, fb, sb, sorted(shared)))

    for fa, sa, fb, sb, shared in conflicts:
        print(f"{fa}: {sa}\n  vs {fb}: {sb}\n  shared: {', '.join(shared)}\n")
    print(f"{len(conflicts)} cross-file same-specificity conflicts")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "web/static/style"))
