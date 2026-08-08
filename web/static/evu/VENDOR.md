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

App-specific styles and class aliases live in [`../style/`](../style/).

## Local patches

Carry these forward on the next sync; both are upstream bugs, not app preferences.

### `theme-autoload.js` — scheme button query must be button-qualified

`bindThemeControls` selected scheme buttons with a bare `[data-evu-scheme]`, but
`applyScheme()` writes that same attribute onto `<html>`. The root element
therefore matched and was given `aria-pressed`, which `<html>` is not allowed to
have — a critical `aria-allowed-attr` violation on every page. Changed to
`button[data-evu-scheme]`, matching how the palette buttons are already queried
two blocks below.

### Status colours used as text (worked around in app CSS, not patched here)

`--success` / `--warning` / `--destructive` / `--secondary` are fill colours
paired with white-ish `*-foreground`. Used directly as small text on their own
12–18% tints — which both the theme's `.evu-pill--ok` and the app's status
chips do — they land between 2.7:1 and 4.1:1 in light mode. The app defines
`--evuproxy-*-text` variants in [`../style/tokens.css`](../style/tokens.css) and
overrides the label colour rather than editing the vendored file. If upstream
ever ships text-safe status tokens, drop the app tokens in favour of those.

## Sync notes (833a0ab)

- Outline / secondary / danger buttons are **elevated** (`--evu-card` fill + light shadow) so they stay readable on page, card, and `muted/55` groups.
- New variant: `.evu-btn--danger-outline`.
- Ghost remains chrome-only (menus/dismiss), not form actions on nested panels.
- Form contrast law unchanged: page → card → `muted/55` groups → `--background` input wells.
