# Enigma PDF Watermark (example tool)

Puts a visible, traceable watermark on PDFs before you share them, written as a single HTML
file for Sanctum. Each marked file gets its own ID, and the name of the person it is for is on
every page. Everything runs in the tool window. Nothing is uploaded, stored or sent.

It started as a web app (React, an Express server, shadcn components). The server did nothing
for the PDFs, so it is gone, along with the build and the framework. What is left is the part
that mattered: the watermark engine, now with working geometry for turned pages and a
batch queue that saves a ZIP.

## What it asks Sanctum for

Nothing. The approval screen is empty: no storage, no network host, no smart card, no device
access. A test (`pdf_watermark_example_asks_for_nothing` in `src-tauri/src/commands/scan.rs`)
pins that against the built file.

## What it does to a PDF

1. Reads the file, takes its SHA-256 and makes an ID: ten random characters, a dash, and four
   characters of the SHA-256.
2. On every page: tiled diagonal text, optional corner stamps and bottom band, optional closer
   tiles over the bottom quarter, and three near invisible copies of the ID.
3. Writes `ETSWatermarkID`, `ETSWatermarkFingerprint`, `ETSWatermarkRecipient` and
   `ETSWatermarkDate` into the information dictionary, and the ID and fingerprint into the
   keywords. The original title is kept.
4. Saves each file, or all of them in a ZIP with a `receipt.json` (IDs, recipients, SHA-256 of
   the original and the marked file, no content).

Pages with `/Rotate` and page boxes that do not start at zero are handled: marks are placed in
what a viewer shows, then mapped to the page's own space (`frame()` in the core).

## Limits

- Deterrence, not protection. A PDF editor removes the marks. The hidden marks do not survive
  printing or a screenshot.
- Text is drawn in Helvetica Bold, so characters outside WinAnsi become `?`. The count is shown.
- Password protected PDFs are refused with a clear message. They are not decrypted.
- At most 200 MB per file, and 2,500 tiles per page (the spacing widens to stay under it).
- Saving a file is a click on a download link. Sanctum puts it in the Downloads folder, and the
  page cannot see whether that worked, so it says where to look. Sanctum must be a version that
  allows tool downloads. A window can save 25 files.

## Files

- `src/app.template.html` is the interface. It has two placeholders where code is inlined.
- `src/watermark-core.js` is the engine (no DOM, no network): ids, template, tile geometry,
  page rotation, the zip writer, the watermark itself and the receipt.
- `vendor/pdf-lib.min.js` is pdf-lib 1.17.1 (MIT), unmodified, pinned by SHA-256. See
  `vendor/README.md`.
- `index.html` is the built single file that you add to Sanctum.
- `test/` has the tests. `core.test.mjs` builds real PDFs with pdf-lib, marks them, and reads
  the result back. The zip test opens the archive with Python's `zipfile` (and `unzip` if present).

## Rebuild and test

```bash
node build.mjs
node --test test/*.test.mjs
```

The build needs only Node. It fails if a placeholder or a source is missing, if pdf-lib is not
the pinned file, or if a source contains `</script`. CI rebuilds `index.html` and fails if it
differs from the committed one, and fails on any capability string in the code we wrote.

## Licence and credit

Part of Sanctum, AGPL-3.0. Uses pdf-lib (MIT, Andrew Dillon). Icons are from Lucide (ISC). The
idea and settings come from the standalone PDF Watermark web app this replaces.
