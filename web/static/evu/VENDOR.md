# Vendored Evu Theme

Copied from the local [imevul/evu_theme](https://github.com/imevul/evu_theme) checkout at `/home/jonas/work/evu_theme`.

| Field | Value |
| --- | --- |
| Upstream commit | `833a0abdf43c7dc502223b91219c205d7cc35136` |
| Working tree | clean (`main` matches `origin/main`) |
| Copied files | `tokens.css`, `base.css`, `components.css`, `layouts.css`, `evu.css`, `theme.js`, `theme-autoload.js` |
| Content changed vs previous vendor | `components.css` only (sha256 `d4a7c23a…` → `7f18cd2f…`) |
| Unchanged vs previous vendor | `tokens.css`, `base.css`, `layouts.css`, `evu.css`, `theme.js`, `theme-autoload.js` |
| Palette default | `indigo` (`data-evu-palette` on `<html>`) |

App-specific styles and class aliases live in [`../style.css`](../style.css).

## Sync notes (833a0ab)

- Outline / secondary / danger buttons are **elevated** (`--evu-card` fill + light shadow) so they stay readable on page, card, and `muted/55` groups.
- New variant: `.evu-btn--danger-outline`.
- Ghost remains chrome-only (menus/dismiss), not form actions on nested panels.
- Form contrast law unchanged: page → card → `muted/55` groups → `--background` input wells.
