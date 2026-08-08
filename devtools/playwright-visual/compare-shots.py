#!/usr/bin/env python3
"""
Pixel-diff two screenshot sets produced by `make playwright-visual`.

    python3 compare-shots.py screenshots/visual-before screenshots/visual-after

Prints one line per surface with the share of differing pixels, plus a bounding
box of the change so it is obvious whether a diff is a whole-page shift or a
single component. Byte comparison is useless here — PNG encoding is not stable —
and eyeballing 42 image pairs is not either.
"""
import os
import sys

from PIL import Image, ImageChops


def compare(a_path, b_path):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return None, a.size, b.size
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    if bbox is None:
        return 0.0, bbox, None
    changed = sum(1 for px in diff.getdata() if px != (0, 0, 0))
    return changed / (a.size[0] * a.size[1]), bbox, None


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    before, after = sys.argv[1], sys.argv[2]
    names = sorted(f for f in os.listdir(before) if f.endswith(".png"))
    identical = 0
    for name in names:
        b_path = os.path.join(after, name)
        if not os.path.exists(b_path):
            print(f"{'MISSING':>9}  {name}")
            continue
        share, bbox, other = compare(os.path.join(before, name), b_path)
        if share is None:
            print(f"{'RESIZED':>9}  {name}  {bbox} -> {other}")
        elif share == 0.0:
            identical += 1
        else:
            print(f"{share * 100:8.3f}%  {name}  bbox={bbox}")
    print(f"\n{identical}/{len(names)} identical")


if __name__ == "__main__":
    main()
