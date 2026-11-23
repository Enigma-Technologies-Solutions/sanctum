# Shamir (example tool)

Splits a secret into shares and rebuilds it from any k of them (Shamir's secret sharing),
written as a single HTML file for Sanctum. Everything runs in the tool window. Nothing is
stored, downloaded or sent.

## What it asks Sanctum for

Nothing. The approval screen is empty: no storage, no network host, no smart card, no
device access. Results leave the window only through the clipboard, when you press a copy
button.

## Formats

| Format | Looks like | Notes |
|---|---|---|
| Sanctum (`ss1`, default) | `ops-ss1-3-0b704569-<hex>-c852` | Records how many shares are needed and a set id, has a checksum on each share, and hides a check value inside the secret. Wrong, mistyped, mixed or missing shares give a clear error instead of a wrong secret. Optional length padding. The checks are not secret, so they catch mistakes, not forgery. |
| Plain | `03-<hex>` | Same bytes as ssss-made-easy and the shamir-secret-sharing npm package (secret bytes, then the share's x coordinate). No checks are possible: too few shares give a wrong answer without a warning. |

These shares do not work with the `ssss-split` and `ssss-combine` command line tools.
The secret limit is 1024 bytes. Sanctum shares are padded to a multiple of 32 bytes by
default so a share does not show the exact secret length.

The checks catch mistakes. They do not stop a dishonest share holder from forging a share, and a matching check does not prove the secret is the original. Compare the SHA-256 you recorded when you split for that.

## Behaviour inside Sanctum

- **No files.** Shares are copied to the clipboard and never written to disk. (Tool windows can
  save a file through a download link, which goes to the Downloads folder, but a share left in
  a file is easy to forget.) If the clipboard is blocked, the text is shown selected in a box.
  Reading the clipboard is never needed: paste shares into the text box.
- **Secrets are masked** and hidden again after 60 seconds without typing or when you
  switch tabs. Clear empties the fields and the bytes the page holds, on a best effort basis.

## How it looks

The page uses the shared Enigma tool kit in `examples/_kit` (see `docs/tool-design.md`). It opens
in a light theme. The button in the header switches the window to dark; the choice is not stored,
so the tool still asks for nothing. The fonts (Inter, Poppins, Space Mono) are embedded in the file.

## Files

- `src/app.template.html` is the interface. It has placeholders where the core and the kit are
  inlined.
- `src/shamir-core.js` is the crypto core (no DOM, no network).
- `index.html` is the built single file that you add to Sanctum.
- `screens.mjs` holds the scenes for the registry screenshots (`node scripts/tool-screens.mjs shamir`).

## Rebuild

```bash
node build.mjs
```

The build needs only Node. It inlines the core and the kit (`../_kit`, with the fonts from
`src/assets/fonts`). It fails if the core or a placeholder is missing, if the core contains
`</script`, or if the kit would add a capability. `--mock <file>` inlines a different core, and `--out <path>`
writes somewhere else, for testing the interface with a stand-in core.

## Licence and credit

Part of Sanctum, AGPL-3.0. This is a clean-room port, written from a specification and
inspired by [0xjjpa/ssss-made-easy](https://github.com/0xjjpa/ssss-made-easy) (Martin
Carpella and 0xjjpa, GPL-3.0). It contains none of that code. The plain format matches the
layout of the `shamir-secret-sharing` npm package (Apache-2.0, Privy). Icons are from
Lucide (ISC). Fonts are Inter, Poppins and Space Mono (SIL OFL 1.1).
