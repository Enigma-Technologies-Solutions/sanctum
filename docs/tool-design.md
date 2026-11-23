# Designing Enigma tools

This document sets the look and the rules for the single-file tools that Enigma publishes for
Sanctum (the folders in `examples/`). They share one UI kit, kept in `examples/_kit/`, which
every tool inlines when it is built. A change to the kit reaches every tool on its next build.

## Rules

- **Light by default.** Every tool opens in the light theme. A button in the header switches
  the current window to dark and back.
- **The theme is not stored.** The choice lives in an attribute on `<html>` and ends with the
  window. Tools do not use browser storage, cookies or any other store to remember it. A tool
  that asks Sanctum for no access must stay that way, and Sanctum's scanner treats any storage
  call as a request for storage.
- **Nothing from the network.** Fonts, icons and styles are inside the file. The fonts are the
  app's own (Inter, Poppins, Space Mono, from `src/assets/fonts`), embedded as `data:` URIs.
- **One column.** Content sits in a centred column at most 920 px wide, with a gutter of 16 to
  40 px. The order is: header bar, hero, notices, info boxes, numbered steps, footer.
- **Ink leads, neutrals carry, volt highlights.** Volt (`#FBFF00`) is a fill with ink on top:
  the primary button, the step numbers, the accent in the title. It is never a text colour on
  white. In the dark theme it may also mark focus and lines.
- **Type.** Poppins for the title and step headings. Inter for everything a person reads. Space
  Mono for data (hashes, file names, codes) and for the small uppercase labels: the eyebrow, the
  wordmark and the titles of info boxes. Body copy is never set in Space Mono.
- **Icons** are Lucide, inline SVG symbols. No emoji in the interface.

## Copy

- Plain, formal sentences. Say what happens and what the person should do next. No marketing
  tone, no exclamation marks.
- No em dashes or en dashes. Rewrite the sentence instead of swapping the punctuation.
- Buttons are verbs in sentence case: "Choose a file", "Check file", "Copy hash".
- Errors say what went wrong and what to try: "The file could not be read. Choose it again."
- The info boxes describe what the tool does with the person's data, in three short titles such
  as "Stays here", "Asks for nothing" and one limit that matters for this tool.
- The footer names the tool and its version, the licence, the standards it follows, and the
  credits for icons and fonts.

## Tokens

Defined on `:root` (light) and redefined under `:root[data-theme="dark"]`. Use the tokens in a
tool's own CSS instead of raw colours, so both themes work.

| Token | Use |
| --- | --- |
| `--bg`, `--surface`, `--raised` | Page, panels and inputs at rest, hover fills |
| `--line`, `--line-2`, `--field-line` | Dividers, panel borders, input borders (3:1 or more) |
| `--ink`, `--ink-2`, `--mute`, `--faint` | Text from strongest to weakest; all pass AA on `--bg` |
| `--volt`, `--on-volt`, `--volt-hover`, `--volt-edge`, `--volt-tint` | The accent fill and the ink on it |
| `--accent-line`, `--focus`, `--sel-bg`, `--sel-fg` | Kicker lines, focus ring, selected tab or option |
| `--ok-*`, `--bad-*`, `--warn-*`, `--info-*` | Status: `-fg` text and icons, `-line` borders, `-tint` fills |
| `--display`, `--body`, `--mono` | Poppins, Inter, Space Mono, with system fallbacks |
| `--r`, `--r-lg` | Corner radius: 8 px for controls, 12 px for panels |
| `--maxw`, `--gap`, `--s1` to `--s7` | Column width, side gutter, spacing (4, 8, 12, 16, 24, 32, 48 px) |

Contrast was checked for both themes: body text 19.8:1 (light) and 17.6:1 (dark), muted text
6.8:1 and 8.3:1, status text on its tint 4.9:1 or more, input borders 3.9:1 and 4.0:1.

## Components

Class names, with the markup the kit expects. The kit's shared icons are `#i-sun`, `#i-moon`,
`#i-lock`, `#i-shield`, `#i-info`, `#i-alert`, `#i-check`, `#i-cross`, `#i-x`, `#i-upload`,
`#i-download`, `#i-copy` and `#i-file`. Use them as `<svg class="i" aria-hidden="true"><use href="#i-copy"/></svg>`.

**Header bar.** The ETS mark, the wordmark and the theme switch.

```html
<header class="bar">
  <div class="wrap bar-in">
    <div class="mark">
      <span class="ets-badge" aria-hidden="true"><span class="ets">ETS</span></span>
      <span class="wordmark">Enigma <b>/</b> Hash Check</span>
    </div>
    <div class="bar-end">
      <button class="theme-toggle" type="button" data-theme-toggle aria-pressed="false" aria-label="Dark theme" title="Dark theme"><svg class="i i-moon" aria-hidden="true"><use href="#i-moon"/></svg><svg class="i i-sun" aria-hidden="true"><use href="#i-sun"/></svg></button>
    </div>
  </div>
</header>
```

**Hero.** `.hero` holds `.eyebrow` ("Tool for Sanctum"), `h1` and `.lede`. The title carries the
accent as `<span class="dash" aria-hidden="true"></span>` between two words, or as
`<span class="hl">word</span>`, a volt band under one word. In `.lede`, a `<span>` sets the
second sentence in the muted colour.

**Notice.** `.notice` with `.ok`, `.warn` or `.bad`, an icon and the text. Add `role="alert"`
when it appears because something went wrong, `role="status"` when it reports progress.

**Info boxes.** `.facts` (role `list`) holding three `.fact` (role `listitem`), each with an
`h3` (icon and title) and a `p`. They stack on narrow windows.

**Numbered step.**

```html
<section class="block" aria-labelledby="h-file">
  <div class="step-head"><span class="step-n" aria-hidden="true">1</span><h2 id="h-file"><span class="sr">Step 1: </span>Choose the file</h2></div>
  <p class="sub">One sentence on what to do here.</p>
  ...
</section>
```

`.kicker` is still available for a section label that is not a step.

**Field.** `.field` holds `label.lab` (tied to the input by `for`), the input and `p.hint`
(tied by `aria-describedby`). Inputs, selects and text areas are styled without a class. Mark an
invalid value with `aria-invalid="true"` and give the reason in `.hint.bad`.

**Buttons.** `.btn` is the primary action (volt). `.btn.ghost` is secondary, `.btn.danger` is a
destructive secondary action, `.btn.sm` is the small size. `.actions` lays a row of buttons out.

**File picker.** `.picker` holds a `.btn` that opens the hidden `input[type=file]` and a
`.picked` line that names the chosen file.

**Tabs and options.** `.tabs` (role `tablist`, buttons with `role="tab"` and `aria-selected`)
switches panels. `.seg` (role `group`, buttons with `aria-pressed`) picks one option. They look
alike; the roles differ.

**Progress.** A plain `<progress>` element.

**Result panel.** `.verdict` with `.ok` (success), `.bad` (mismatch or error) or `.warn`, plain
for information. It holds an icon and a `div` with `strong` (the verdict) and `p` (what it means
and what to do). Give it `role="status"`.

**Copy.** A value to copy goes in `output.readout`. The copy button is `.btn.ghost.sm` with
`#i-copy`. If the clipboard is blocked, select the value and tell the person to press Ctrl+C or
Cmd+C, as Hash Check does. Status lines go in `p.msg` with `role="status"`.

**Footer.** `footer.foot` with a `.wrap` inside.

Helpers: `.wrap`, `.muted`, `.small`, `.mono`, `.sr` (visually hidden), `.i` (icon).

## Accessibility

- Every control has a visible focus ring (`--focus`, 2 px).
- Every input has a label. Groups of buttons are labelled with `aria-labelledby`.
- Live messages use `role="status"`; failures that stop the work use `role="alert"`.
- Decorative icons and the step numbers are `aria-hidden`. The step number is repeated for
  screen readers inside the heading.
- The theme switch is a toggle button: `aria-pressed` says whether dark is on.

## Using the kit

A template marks three places, each exactly once:

| Placeholder | Where | Becomes |
| --- | --- | --- |
| `/*__KIT_CSS__*/` | first thing inside `<style>` | tokens, components and the embedded fonts |
| `<!--__KIT_ICONS__-->` | right after `<body>` | the shared icon symbols |
| `/*__KIT_JS__*/` | inside a `<script>` after the markup | the theme switch (`globalThis.EnigmaKit`) |

The tool's own CSS follows the kit inside the same `<style>`. Its own icons go in a second
sprite, with ids the kit does not use. Set `<html lang="en" data-theme="light">`,
`<meta name="theme-color" content="#FFFFFF">`, and add `font-src data:` to the page's CSP, or the
browser refuses the embedded fonts.

The tool's `build.mjs` calls `applyKit(html)` from `examples/_kit/kit.mjs` after inlining its
core. `applyKit` fails the build if a placeholder is missing or repeated, if an icon id is
defined twice, or if the kit text contains any string Sanctum's scanner reads as a capability.
`examples/_template` is a complete example; its README explains how to start a new tool.

After a build, check what Sanctum will ask for, and compare it with the result before the change:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example scan_declared -- examples/<tool>/index.html
```

Registry screenshots are drawn by `scripts/tool-screens.mjs`, which loads the built file in
headless Chrome, runs a short scene for each picture and writes them at 1600 by 1131 pixels.
A tool's scenes go in `examples/<tool>/screens.mjs`, whose default export is
`{ appId, scenes }`; each scene is a page script that can use the helpers in that script
(`$`, `type`, `press`, `until`, `pickFile`, `scrollToEl`). A tool that moves focus after an
action scrolls the page, so call `window.scrollTo(0, 0)` before `scrollToEl` in that scene.

The kit adds about 120 KB to a tool, almost all of it the fonts.

## Audit, November 2026

The four tools started from one stylesheet and drifted. All four were dark only.

| | Shamir | OTP Vault | PDF Watermark | Hash Check |
| --- | --- | --- | --- | --- |
| Build | template and core | hand-written `index.html` (now template and core) | template, core and pdf-lib | template and core |
| Width | 980 px | 980 px | 980 px | 980 px |
| Header wordmark | "Enigma / Shamir · Sanctum" | "Enigma / OTP Vault · Sanctum", extra controls on the right | "Enigma / PDF Watermark" | "Enigma / Hash Check" |
| Eyebrow | long company line | long company line, RFC number | "Tool for Sanctum" | "Tool for Sanctum" |
| Title | lowercase "split" and "combine" joined by the volt bar, up to 88 px | lowercase on two lines with a volt dot, up to 96 px | sentence, up to 88 px | sentence, up to 88 px |
| Body font | Inter | Space Mono for all text | Inter | Inter |
| Info boxes | none | none | three | three |
| Sections | kickers "01 · Split", tabs | kickers "01 · Access" to "05 · Vault", tabs | "Step 1" to "Step 3" | "Step 1" to "Step 3" |
| Tabs and options | tabs selected in volt, options selected in white | tabs selected in volt, bordered in a fainter line | options selected in white | options selected in white |
| Notices | `.banner` with `role="alert"` | none | none | none |
| Results | `.okline` rows, a stale state | code cards with a countdown bar | a queue list | `.verdict` panel |
| Extras | `h2` focus ring after a tab switch | scanline overlay, emoji font for the key fingerprint | range and checkbox inputs | progress bar |

Common to all four:

- Colours were raw values (`#000`, `rgba(255,255,255,.12)`), so a second theme needed a full
  rewrite. Muted text (`#8A8A8A` on `#0A0A0A`) passed AA, but disabled options at 45 % opacity
  did not, which is allowed for disabled controls but hard to read.
- Inter, Poppins and Space Mono were named but not embedded. On a computer without them, the
  page fell back to system fonts, so the tools looked different from the app and the website.
- Buttons, inputs and panels had square corners; the app and the website use rounded ones.
- Field labels were small uppercase Space Mono, which is hard to read at 11 px.
- The theme colour meta tag was `#0a0a0a`.

What the kit settles: one width, one header with the theme switch, one hero, info boxes, steps
with a volt number, one style of tabs and options (selected in ink), labels in Inter, notices and
result panels with four status colours, embedded fonts, and tokens for both themes.

## Migrating a tool

1. Run `scan_declared` on the current `index.html` and keep the output.
2. Replace the tool's `:root` block and every rule the kit already covers with
   `/*__KIT_CSS__*/`. Keep only the tool's own components, rewritten with the tokens.
3. Add the icon and script placeholders, the theme switch in the header, `data-theme="light"`,
   the white theme colour and `font-src data:` in the CSP. Remove icon symbols the kit provides.
4. Use the kit's markup for the hero, info boxes, steps, fields, buttons, tabs, notices and
   results. Keep every element id the script uses, and keep the script unchanged.
5. Call `applyKit` in `build.mjs`. A tool that is a hand-written `index.html` first needs a
   `src/app.template.html` and a `build.mjs`, as OTP Vault got, so that the kit can be inlined.
6. Build, run the tests, run `scan_declared` again and compare. The declared capabilities must
   not change. Check both themes by eye.
7. Bump the patch version in the tool and in `registry/apps/<app id>/CHANGELOG.md`, then
   regenerate the screenshots. Signing is done later by the maintainer.
