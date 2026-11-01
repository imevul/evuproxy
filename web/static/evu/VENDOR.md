# Vendored Evu Theme

Copied from the local [imevul/evu_theme](https://github.com/imevul/evu_theme) checkout at `/home/jonas/work/libraries/evu_theme`.

| Field | Value |
| --- | --- |
| Upstream commit | `f3739a5f9ce19d4ef7a848d09d555fdb6674eaf8` |
| Working tree | clean apart from the untracked `.ds-check/` (`main` matches `origin/main`) |
| Copied files | `tokens.css`, `base.css`, `components.css`, `layouts.css`, `evu.css`, `theme.js`, `theme-autoload.js` |
| Content changed vs previous vendor | `tokens.css`, `components.css`, `theme.js`, `theme-autoload.js` |
| Unchanged vs previous vendor | `base.css`, `layouts.css`, `evu.css` |
| Palette default | `indigo` (`data-evu-palette` on `<html>`) |

App-specific styles and class aliases live in [`../style/`](../style/).

## Local patches

None. The `theme-autoload.js` scheme button patch is now upstream.

## Upstream gaps

### Status colours used as text (worked around in app CSS, not patched here)

`--success` / `--warning` / `--destructive` / `--secondary` are fill colours
paired with white-ish `*-foreground`. Used directly as small text on their own
12–18% tints — which both the theme's `.evu-pill--ok` and the app's status
chips do — they land between 2.7:1 and 4.1:1 in light mode. The app defines
`--evuproxy-*-text` variants in [`../style/tokens.css`](../style/tokens.css) and
overrides the label colour rather than editing the vendored file. If upstream
ever ships text-safe status tokens, drop the app tokens in favour of those.

## Sync notes (f3739a5)

- New `--control-border` / `--evu-control-border` token, and motion tokens (`--evu-ease-out`, `--evu-duration-press`, `--evu-duration-fast`, `--evu-duration-enter`).
- `.evu-btn` scales on press, with reduced motion respected.
- New `.evu-checkbox`, `.evu-check`, `.evu-check-group`, `.evu-toaster` and `.evu-toast`. Toasts are styles only; each app supplies the timer and behaviour.
- The app's forms do not use the new checkbox yet. The checkbox rules in [`../style/forms.css`](../style/forms.css) stay until the form migration, and override `.evu-checkbox` by specificity.

## Sync notes (833a0ab)

- Outline / secondary / danger buttons are **elevated** (`--evu-card` fill + light shadow) so they stay readable on page, card, and `muted/55` groups.
- New variant: `.evu-btn--danger-outline`.
- Ghost remains chrome-only (menus/dismiss), not form actions on nested panels.
- Form contrast law unchanged: page → card → `muted/55` groups → `--background` input wells.
