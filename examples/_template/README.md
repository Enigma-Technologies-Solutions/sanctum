# Tool template

The starting point for a new Enigma tool for Sanctum. It is a small working tool, Text Count,
that uses every part of the shared UI kit: the header with the theme switch, the hero, a notice,
the info boxes, numbered steps, tabs, a file picker, options, a result panel, a value to copy
and the footer. The design rules are in `docs/tool-design.md`.

## Files

- `src/app.template.html` is the interface. It has placeholders where the kit and the core are
  inlined.
- `src/tool-core.js` is the logic: no DOM, no imports, no network. The page and the tests both
  call it.
- `build.mjs` inlines the core and the kit (`../_kit`) and writes `index.html`.
- `test/core.test.mjs` tests the core and checks that the build works.

## Start a new tool

1. Copy the folder and give it the tool's name, for example `examples/word-list`. Do not keep
   the built `index.html` of the template, if there is one.
2. Choose the app id, such as `sh.enigma.word-list`. It is not written in the page; it is used
   when the tool is signed and in `registry/apps/<app id>/`.
3. In `src/app.template.html`, change the `<title>`, the description meta tag, the wordmark
   ("Enigma / Text Count"), the hero, the info boxes, the steps and the footer. Keep the three
   kit placeholders, `data-theme="light"` on `<html>` and `font-src data:` in the CSP.
4. Replace `src/tool-core.js` with the tool's logic. If you rename the file or the global it
   sets (`ToolCore`), change `build.mjs` and the page script to match.
5. Write tests in `test/` and run them:

   ```bash
   node --test examples/word-list/test/*.test.mjs
   ```

6. Build:

   ```bash
   node examples/word-list/build.mjs
   ```

   The build fails if a placeholder is missing or repeated, or if an icon id is defined twice.
   It prints a note if the page contains a string that Sanctum reads as a capability.

7. Check what Sanctum will ask the user to approve:

   ```bash
   cargo run --manifest-path src-tauri/Cargo.toml --example scan_declared -- examples/word-list/index.html
   ```

   A tool that needs nothing prints `[]`. Anything else must be something the tool really uses.

8. Open `index.html` in Sanctum and try it in both themes.
9. For the registry, add scenes for the screenshots to `scripts/tool-screens.mjs`, write
   `registry/apps/<app id>/` (app.json, CHANGELOG.md, manual.md) and add the tool's tests and
   build check to `.github/workflows/examples.yml`. The maintainer signs the tool with
   `scripts/sign-example.sh`.

## Licence

Part of Sanctum, AGPL-3.0. Icons are from Lucide (ISC). Fonts are Inter, Poppins and Space Mono
(SIL OFL 1.1).
