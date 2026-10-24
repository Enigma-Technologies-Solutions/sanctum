import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PDFLib, core } from "./load.mjs";

const { PDFDocument, StandardFonts, degrees, decodePDFRawStream, PDFRawStream, PDFName, PDFArray } = PDFLib;

const SETTINGS = { recipient: "Case 4471", opacity: 0.2 };

async function makePdf(pages = [[300, 400]], rotations = []) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach(([w, h], i) => {
    const p = doc.addPage([w, h]);
    p.drawText(`Original page ${i + 1}`, { x: 40, y: h - 60, size: 14, font });
    if (rotations[i]) p.setRotation(degrees(rotations[i]));
  });
  doc.setTitle("My passport scan");
  doc.setKeywords(["passport"]);
  return doc.save();
}

/** All text drawn on a page, as the hex strings the content stream holds, plus decoded streams. */
function contentOf(page) {
  const refs = page.node.Contents();
  const arr = refs instanceof PDFArray ? refs.asArray() : [refs];
  let out = "";
  for (const r of arr) {
    const s = page.doc.context.lookup(r);
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    out += Buffer.from(bytes).toString("latin1") + "\n";
  }
  return out;
}
const hex = (s) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

// ---------------------------------------------------------------- text

test("text is made drawable, and the person is told how much changed", () => {
  assert.deepEqual(core.sanitize("Case 4471 \u2022 Ana"), { text: "Case 4471 \u2022 Ana", replaced: 0 });
  assert.deepEqual(core.sanitize("Jos\u00e9"), { text: "Jos\u00e9", replaced: 0 });
  const r = core.sanitize("\u0639\u0644\u064a Li\n\u2603");
  assert.equal(r.replaced, 4);
  assert.equal(r.text, "??? Li ?");
  assert.equal(core.sanitize("\u{1F600}").replaced, 1);
});

test("the template fills its own words and leaves other braces alone", () => {
  const v = { UID: "U1", DATE: "2026-10-24", RECIPIENT: "R", PAGE: 2, PAGES: 9 };
  assert.equal(core.fill("{UID}|{DATE}|{RECIPIENT}|{PAGE}/{PAGES}|{x}|{uid}", v), "U1|2026-10-24|R|2/9|{x}|{uid}");
  assert.equal(core.fill("{UID}{UID}", v), "U1U1");
});

test("settings are always complete and inside their limits", () => {
  const d = core.normalizeSettings();
  assert.equal(d.template, core.DEFAULT_TEMPLATE);
  assert.equal(d.color, "red");
  const s = core.normalizeSettings({ opacity: 9, rotation: -500, fontSize: 1, spacing: "x", color: "pink", recipient: "  a   b \n c ", bogus: 1, template: "   " });
  assert.equal(s.opacity, core.LIMITS.opacity[1]);
  assert.equal(s.rotation, core.LIMITS.rotation[0]);
  assert.equal(s.fontSize, core.LIMITS.fontSize[0]);
  assert.equal(s.spacing, core.LIMITS.spacing[0]);
  assert.equal(s.color, "red");
  assert.equal(s.recipient, "a b c");
  assert.equal(s.template, core.DEFAULT_TEMPLATE);
  assert.ok(!("bogus" in s));
  assert.equal(core.normalizeSettings({ recipient: "x".repeat(500) }).recipient.length, core.MAX_RECIPIENT_CHARS);
  assert.equal(core.normalizeSettings({ template: "y".repeat(900) }).template.length, core.MAX_TEMPLATE_CHARS);
});

// ---------------------------------------------------------------- ids

test("ids are ten characters, a dash and four of the file's fingerprint, and do not repeat", () => {
  assert.equal(core.base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])), "ZZZZZZZZ");
  assert.equal(core.base32(new Uint8Array([0, 0, 0, 0, 0])), "00000000");
  assert.equal(core.makeUid(new Uint8Array(8), "abcd1234"), "0000000000-ABCD");
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    const uid = core.makeUid(b, "0f9a5c");
    assert.match(uid, /^[0-9A-HJKMNP-TV-Z]{10}-0F9A$/);
    seen.add(uid);
  }
  assert.equal(seen.size, 500);
});

// ---------------------------------------------------------------- geometry

test("a page turned by /Rotate maps its visual corners onto the page's own corners", () => {
  const w = 300, h = 400;
  const at = (r, vx, vy) => core.frame(r, w, h).toPage(vx, vy, 0);
  // Visual size swaps for 90 and 270.
  assert.deepEqual([core.frame(90, w, h).vw, core.frame(90, w, h).vh], [400, 300]);
  assert.deepEqual([core.frame(180, w, h).vw, core.frame(180, w, h).vh], [300, 400]);
  assert.deepEqual([core.frame(270, w, h).vw, core.frame(270, w, h).vh], [400, 300]);
  assert.deepEqual([core.frame(-90, w, h).vw, core.frame(-90, w, h).vh], [400, 300], "-90 is 270");
  // Visual bottom left, and the direction text runs, for each turn.
  assert.deepEqual(at(0, 0, 0), { x: 0, y: 0, angle: 0 });
  assert.deepEqual(at(90, 0, 0), { x: w, y: 0, angle: 90 });
  assert.deepEqual(at(180, 0, 0), { x: w, y: h, angle: 180 });
  assert.deepEqual(at(270, 0, 0), { x: 0, y: h, angle: 270 });
  // Every visual corner lands on a page corner, never outside.
  for (const r of [0, 90, 180, 270]) {
    const f = core.frame(r, w, h);
    for (const [vx, vy] of [[0, 0], [f.vw, 0], [0, f.vh], [f.vw, f.vh]]) {
      const m = f.toPage(vx, vy, 0);
      assert.ok([0, w].includes(m.x) && [0, h].includes(m.y), `${r}: ${vx},${vy} -> ${m.x},${m.y}`);
    }
  }
  // Moving right on screen moves along the direction the text is drawn in.
  for (const r of [0, 90, 180, 270]) {
    const f = core.frame(r, w, h);
    const a = f.toPage(10, 10, 0), b = f.toPage(20, 10, 0);
    const rad = (a.angle * Math.PI) / 180;
    assert.ok(Math.abs(b.x - a.x - 10 * Math.cos(rad)) < 1e-9 && Math.abs(b.y - a.y - 10 * Math.sin(rad)) < 1e-9, `r=${r}`);
  }
});

/** Is the point inside the rotated box of a tile? */
function covered(tiles, tw, th, angle, px, py) {
  const c = Math.cos((angle * Math.PI) / 180), s = Math.sin((angle * Math.PI) / 180);
  return tiles.some((t) => {
    const dx = px - t.x, dy = py - t.y;
    const u = dx * c + dy * s, v = -dx * s + dy * c;
    return u >= 0 && u <= tw && v >= 0 && v <= th;
  });
}

test("tiles reach every part of the page at any angle, and none lie wholly outside it", () => {
  const vw = 595, vh = 842, tw = 260, th = 18;
  for (const angle of [0, 35, 45, -30, 90, -90]) {
    const tiles = core.tileOrigins(vw, vh, tw, th, 60, angle);
    assert.ok(tiles.length > 10, `angle ${angle}`);
    // The gap between rows is 60, so every sample of a 40 by 40 grid must sit within a row's pitch
    // of some tile. Check the stronger thing: tile boxes are inside or touch the page.
    const c = Math.cos((angle * Math.PI) / 180), s = Math.sin((angle * Math.PI) / 180);
    for (const t of tiles) {
      const xs = [t.x, t.x + tw * c, t.x - th * s, t.x + tw * c - th * s];
      const ys = [t.y, t.y + tw * s, t.y + th * c, t.y + tw * s + th * c];
      assert.ok(Math.max(...xs) >= 0 && Math.min(...xs) <= vw && Math.max(...ys) >= 0 && Math.min(...ys) <= vh);
    }
    // No stretch of the page larger than one tile pitch is empty: a point every 50 units is within
    // reach (distance) of some tile box.
    const pitch = Math.hypot(tw + 60, th + 60);
    for (let x = 0; x <= vw; x += 50) {
      for (let y = 0; y <= vh; y += 50) {
        const near = tiles.some((t) => Math.hypot(t.x + (tw * c - th * s) / 2 - x, t.y + (tw * s + th * c) / 2 - y) <= pitch);
        assert.ok(near, `angle ${angle}: nothing near ${x},${y}`);
      }
    }
  }
});

test("rows are staggered, so tiles do not line up in columns", () => {
  const tiles = core.tileOrigins(600, 800, 100, 10, 20, 0);
  const rows = new Map();
  for (const t of tiles) rows.set(Math.round(t.y), [...(rows.get(Math.round(t.y)) ?? []), t.x]);
  const keys = [...rows.keys()].sort((a, b) => a - b);
  const first = (k) => Math.min(...rows.get(k).map((x) => ((x % 120) + 120) % 120));
  assert.notEqual(Math.round(first(keys[1])), Math.round(first(keys[2])));
});

test("a huge number of tiles is cut back by widening the gap", () => {
  const r = core.pageTiles(595, 842, 10, 2, 2, 30, false);
  assert.ok(r.tiles.length <= core.MAX_TILES_PER_PAGE);
  assert.ok(r.gap > 2);
  const ok = core.pageTiles(595, 842, 260, 18, 60, 35, false);
  assert.equal(ok.gap, 60, "a normal page keeps the gap it was given");
});

test("sensitive zones make the bottom quarter denser and leave the rest alone", () => {
  const plain = core.pageTiles(595, 842, 260, 18, 60, 0, false);
  const zoned = core.pageTiles(595, 842, 260, 18, 60, 0, true);
  const edge = 842 * core.ZONE_FRACTION;
  const low = (r) => r.tiles.filter((t) => t.y < edge).length;
  const high = (r) => r.tiles.filter((t) => t.y >= edge).length;
  assert.ok(low(zoned) > low(plain) * 1.5, `${low(zoned)} vs ${low(plain)}`);
  assert.equal(high(zoned), high(plain));
});

// ---------------------------------------------------------------- zip

test("a zip opens with standard tools, keeps every byte, and makes names safe and unique", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-zip-"));
  try {
    const big = new Uint8Array(100_000).map((_, i) => (i * 31) % 251);
    const entries = [
      { name: "a.pdf", bytes: big },
      { name: "a.pdf", bytes: new Uint8Array([1, 2, 3]) },
      { name: "../../etc/passwd", bytes: new TextEncoder().encode("x") },
      { name: "caf\u00e9 \u2022.pdf", bytes: new Uint8Array(0) },
      { name: "C:\\evil\\b.pdf", bytes: new Uint8Array([9]) },
    ];
    const z = core.makeZip(entries, new Date(2026, 9, 24, 13, 5, 7));
    const path = join(dir, "t.zip");
    writeFileSync(path, z);
    const py = (code) => execFileSync("python3", ["-c", code, path], { encoding: "utf8" });
    assert.equal(py("import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip())").trim(), "None");
    const names = JSON.parse(py("import zipfile,sys,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))"));
    assert.deepEqual(names, ["a.pdf", "a-2.pdf", "passwd", "caf\u00e9 \u2022.pdf", "b.pdf"]);
    assert.equal(py("import zipfile,sys,hashlib; z=zipfile.ZipFile(sys.argv[1]); print(hashlib.sha256(z.read('a.pdf')).hexdigest())").trim(),
      (await import("node:crypto")).createHash("sha256").update(big).digest("hex"));
    assert.equal(py("import zipfile,sys; i=zipfile.ZipFile(sys.argv[1]).getinfo('a.pdf'); print(i.date_time)").trim(), "(2026, 10, 24, 13, 5, 6)");
    assert.equal(py("import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).getinfo('a.pdf').compress_type)").trim(), "0");
    // unzip, if installed, agrees.
    try {
      execFileSync("unzip", ["-tq", path], { stdio: "pipe" });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    assert.equal(core.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file names for the zip and the output", () => {
  assert.equal(core.safeFileName("..\\..\\x?.pdf"), "x_.pdf");
  assert.equal(core.safeFileName("...", "fb"), "fb");
  assert.equal(core.safeFileName("a".repeat(300) + ".pdf").length, 120);
  assert.equal(core.outputName("Passport.PDF", "U1", {}), "Passport-watermarked.pdf");
  assert.equal(core.outputName("Passport.pdf", "U1", { "passport-watermarked.pdf": true }), "Passport-U1-watermarked.pdf");
  assert.equal(core.outputName("../../x.pdf", "U1", {}), "x-watermarked.pdf");
});

// ---------------------------------------------------------------- the watermark

test("a watermarked file keeps its pages, carries the id in text and metadata, and still opens", async () => {
  const src = await makePdf([[300, 400], [595, 842], [200, 200]]);
  const r = await core.watermark(PDFLib, src, { ...SETTINGS, band: true, zones: true }, null, new Date(2026, 9, 24));
  assert.match(r.uid, /^[0-9A-HJKMNP-TV-Z]{10}-[0-9A-F]{4}$/);
  assert.equal(r.uid.slice(-4), r.sha256.slice(0, 4).toUpperCase());
  assert.equal(r.fingerprint, r.sha256.slice(0, 12));
  assert.equal(r.date, "2026-10-24");
  assert.equal(r.pages, 3);
  assert.notEqual(r.outputSha256, r.sha256);
  assert.equal(r.replaced, 0);

  const out = await PDFDocument.load(r.bytes, { updateMetadata: false });
  assert.equal(out.getPageCount(), 3);
  assert.equal(out.getTitle(), "My passport scan", "the original title is kept");
  assert.match(out.getKeywords(), /passport/);
  assert.ok(out.getKeywords().includes(r.uid));
  assert.match(out.getProducer(), /Enigma PDF Watermark/);
  const info = out.getInfoDict();
  const get = (k) => info.lookup(PDFName.of(k)).decodeText();
  assert.equal(get("ETSWatermarkID"), r.uid);
  assert.equal(get("ETSWatermarkRecipient"), "Case 4471");
  assert.equal(get("ETSWatermarkFingerprint"), r.fingerprint);

  const pages = out.getPages();
  for (let i = 0; i < 3; i++) {
    const c = contentOf(pages[i]);
    assert.ok(c.includes(hex(`${r.uid} p${i + 1}`)), `page ${i + 1} holds the hidden id`);
    assert.ok(c.includes(hex(`${r.uid} \u0095 Page ${i + 1} of 3`)), "corner stamp");
    assert.ok(c.includes(hex(`Shared with: Case 4471`)), "band");
    assert.ok(c.includes(hex("CONFIDENTIAL")), "tiles");
  }
  // The original content is still there, under the mark.
  assert.ok(contentOf(pages[0]).includes(hex("Original page 1")));
});

test("each run gets its own id, and the original bytes are not changed", async () => {
  const src = await makePdf();
  const copy = new Uint8Array(src);
  const a = await core.watermark(PDFLib, src, SETTINGS);
  const b = await core.watermark(PDFLib, src, SETTINGS);
  assert.notEqual(a.uid, b.uid);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(src, copy);
});

test("options switch their parts on and off", async () => {
  const src = await makePdf();
  const count = async (s, needle) => {
    const r = await core.watermark(PDFLib, src, { ...SETTINGS, ...s });
    const out = await PDFDocument.load(r.bytes, { updateMetadata: false });
    return { r, c: contentOf(out.getPages()[0]) };
  };
  const off = await count({ corners: false, band: false });
  assert.ok(!off.c.includes(hex("Shared with")));
  assert.ok(!off.c.includes(hex("Page 1 of 1")));
  const on = await count({ corners: true, band: true });
  assert.ok(on.c.includes(hex("Shared with")));
  assert.ok(on.c.includes(hex("Page 1 of 1")));
  // A template of the person's own.
  const own = await count({ template: "FOR {RECIPIENT} PAGE {PAGE}/{PAGES}" });
  assert.ok(own.c.includes(hex("FOR Case 4471 PAGE 1/1")));
  assert.ok(!own.c.includes(hex("CONFIDENTIAL")));
});

test("characters Helvetica cannot draw are replaced and counted, not fatal", async () => {
  const src = await makePdf();
  const r = await core.watermark(PDFLib, src, { recipient: "\u0639\u0644\u064a Lee" });
  assert.ok(r.replaced > 0);
  const out = await PDFDocument.load(r.bytes, { updateMetadata: false });
  assert.ok(contentOf(out.getPages()[0]).includes(hex("??? Lee")));
});

test("rotated and offset pages are marked inside their visible area", async () => {
  const doc = await PDFDocument.create();
  for (const rot of [0, 90, 180, 270]) {
    const p = doc.addPage([300, 500]);
    p.setRotation(degrees(rot));
  }
  const off = doc.addPage([300, 500]);
  off.setMediaBox(100, 200, 300, 500);
  const src = await doc.save();
  const r = await core.watermark(PDFLib, src, { ...SETTINGS, corners: true });
  const out = await PDFDocument.load(r.bytes, { updateMetadata: false });
  assert.equal(out.getPageCount(), 5);
  assert.deepEqual(out.getPages().map((p) => p.getRotation().angle), [0, 90, 180, 270, 0]);
  for (const p of out.getPages()) assert.ok(contentOf(p).includes(hex(`${r.uid} p`)));
  // The offset page's marks are placed relative to its own box, not the origin.
  const c = contentOf(out.getPages()[4]);
  const tms = [...c.matchAll(/([\d.\-e]+) ([\d.\-e]+) ([\d.\-e]+) ([\d.\-e]+) ([\d.\-e]+) ([\d.\-e]+) Tm/g)];
  assert.ok(tms.length > 0);
  assert.ok(tms.some((m) => Number(m[5]) >= 100 && Number(m[6]) >= 200), "some text starts inside the box");
});

test("progress is reported per page", async () => {
  const src = await makePdf([[200, 200], [200, 200], [200, 200], [200, 200]]);
  const seen = [];
  await core.watermark(PDFLib, src, SETTINGS, (d, t) => seen.push([d, t]));
  assert.deepEqual(seen, [[1, 4], [2, 4], [3, 4], [4, 4]]);
});

test("problems are explained, and nothing is returned", async () => {
  const src = await makePdf();
  const code = async (bytes, s = SETTINGS) => {
    try {
      await core.watermark(PDFLib, bytes, s);
    } catch (e) {
      assert.equal(e.name, "WatermarkError", String(e.stack));
      return e.code;
    }
    return null;
  };
  assert.equal(await code(src, { recipient: "   " }), "no_recipient");
  assert.equal(await code(new TextEncoder().encode("hello, not a pdf")), "not_pdf");
  assert.equal(await code(new TextEncoder().encode("%PDF-1.4\nthis is broken")), "invalid");
  assert.equal(await code(new Uint8Array(0)), "not_pdf");
  const encrypted = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>
endobj
4 0 obj
<< /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>
endobj
trailer
<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [(abcdefghijklmnop) (abcdefghijklmnop)] >>
%%EOF`;
  assert.equal(await code(new TextEncoder().encode(encrypted)), "encrypted");
  const empty = await PDFDocument.create();
  assert.equal(await code(await empty.save({ addDefaultPage: false })), "no_pages");
  const huge = { length: core.MAX_FILE_BYTES + 1 };
  assert.equal(await code(huge), "too_large");
});

test("the receipt lists what was done and holds no document content", async () => {
  const src = await makePdf();
  const r = await core.watermark(PDFLib, src, SETTINGS, null, new Date(2026, 9, 24));
  const text = core.receipt([{ ...r, outputName: "x-watermarked.pdf", originalName: "x.pdf" }], new Date(Date.UTC(2026, 9, 24)));
  const j = JSON.parse(text);
  assert.equal(j.createdAt, "2026-10-24T00:00:00.000Z");
  assert.equal(j.files[0].uid, r.uid);
  assert.equal(j.files[0].originalSha256, r.sha256);
  assert.equal(j.files[0].outputSha256, r.outputSha256);
  assert.equal(j.files[0].recipient, "Case 4471");
  assert.ok(!text.includes("Original page"));
  assert.ok(!("bytes" in j.files[0]));
});

test("sizes read plainly", () => {
  assert.equal(core.formatBytes(0), "0 B");
  assert.equal(core.formatBytes(1536), "1.5 KB");
  assert.equal(core.formatBytes(2 * 1024 * 1024), "2.0 MB");
  assert.equal(core.formatBytes(50 * 1024 * 1024), "50 MB");
});
