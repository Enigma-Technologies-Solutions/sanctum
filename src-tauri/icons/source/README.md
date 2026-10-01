# Desktop icon sources

Rebuild every icon in `src-tauri/icons` from the repo root:

    src-tauri/icons/source/build-icons.sh

It needs python3 (with Pillow), ImageMagick (`magick`) and, on macOS, `iconutil`. `gen-svgs.py` writes the SVGs, so edit the mark there and re-run the script.

Files: `master.svg` (macOS, 824 px body on a 1024 canvas), `linux.svg` (body fills the canvas), `flat.svg` (Windows 128 and 256), `small-N.svg` and `mac-small-N.svg` (hand-tuned, pixel-aligned sizes from 16 to 64, drawn by `raster-small.py`). `alt-wordmark/` holds the old ETS wordmark icon. It is not used by the build.

Design notes:
- The mark is the website favicon: concentric volt outline squares and a solid volt centre on #0A0A0A, all square corners. The 35% and 60% outlines are pre-blended to solid colours.
- From 128 px up all three layers are kept, with thicker strokes than the favicon. At 64 and 48 px the strokes are whole pixels. At 32 and 24 px the faint outer frame is dropped. At 16 px it is one heavy full-volt outline plus the centre.
- On macOS the body itself is the ink tile: a squircle with a faint light rim and a soft shadow, so it does not read as a flat square on a dark Dock.
- Windows uses a flat square, Linux a full-size squircle.
