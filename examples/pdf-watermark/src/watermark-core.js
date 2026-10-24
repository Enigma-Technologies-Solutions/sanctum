/*
 * PDF watermark core for the Sanctum example tool.
 *
 * Plain script: no DOM, no network, no dynamic code. It sets globalThis.WatermarkCore and,
 * under Node, module.exports. The PDF work is done by pdf-lib, which is passed in
 * (WatermarkCore.watermark(PDFLib, ...)) so tests can use the same vendored copy.
 * Platform needs: crypto.getRandomValues, crypto.subtle.digest, TextEncoder.
 *
 * What it does to a page, in order: a tiled diagonal text, optional corner stamps, an optional
 * band along the bottom edge, and a few near invisible copies of the id. Then it writes the id
 * into the file's information dictionary. All of this is deterrence. A person with a PDF editor
 * can remove it, and the hidden marks do not survive printing or a screenshot.
 *
 * Coordinates: "visual" means as a viewer shows the page (origin bottom left, y up), after the
 * page's own /Rotate. `frame()` maps visual points to the page's unrotated space, where pdf-lib
 * draws.
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var TOOL_NAME = "Enigma PDF Watermark";

  var DEFAULT_TEMPLATE = "CONFIDENTIAL • DO NOT SHARE • {UID} • {DATE} • {RECIPIENT}";
  var MAX_FILE_BYTES = 200 * 1024 * 1024;
  var MAX_TILES_PER_PAGE = 2500;
  var MAX_ZIP_BYTES = 0xfffffffe;
  var MAX_ZIP_ENTRIES = 0xfffe;
  var MAX_TEMPLATE_CHARS = 300;
  var MAX_RECIPIENT_CHARS = 80;
  var BAND_HEIGHT = 24;
  var ZONE_FRACTION = 0.25;

  var COLORS = Object.freeze({
    red: [0.78, 0.1, 0.1],
    black: [0, 0, 0],
    grey: [0.35, 0.35, 0.35],
    blue: [0.1, 0.25, 0.7],
  });

  var DEFAULTS = Object.freeze({
    template: DEFAULT_TEMPLATE,
    recipient: "",
    color: "red",
    opacity: 0.22,
    rotation: 35,
    fontSize: 18,
    spacing: 60,
    corners: true,
    band: false,
    zones: false,
  });

  var LIMITS = Object.freeze({
    opacity: [0.05, 0.6],
    rotation: [-90, 90],
    fontSize: [8, 60],
    spacing: [10, 300],
  });

  function WatermarkError(code, message) {
    var e = new Error(message);
    e.name = "WatermarkError";
    e.code = code;
    return e;
  }

  // ------------------------------------------------------------------ small helpers

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  /** Settings with every field present and inside its limits. Unknown keys are dropped. */
  function normalizeSettings(s) {
    s = s || {};
    var out = {
      template: typeof s.template === "string" && s.template.trim() ? s.template : DEFAULTS.template,
      recipient: typeof s.recipient === "string" ? s.recipient : DEFAULTS.recipient,
      color: Object.prototype.hasOwnProperty.call(COLORS, s.color) ? s.color : DEFAULTS.color,
      opacity: clamp(s.opacity === undefined ? DEFAULTS.opacity : s.opacity, LIMITS.opacity[0], LIMITS.opacity[1]),
      rotation: clamp(s.rotation === undefined ? DEFAULTS.rotation : s.rotation, LIMITS.rotation[0], LIMITS.rotation[1]),
      fontSize: clamp(s.fontSize === undefined ? DEFAULTS.fontSize : s.fontSize, LIMITS.fontSize[0], LIMITS.fontSize[1]),
      spacing: clamp(s.spacing === undefined ? DEFAULTS.spacing : s.spacing, LIMITS.spacing[0], LIMITS.spacing[1]),
      corners: s.corners === undefined ? DEFAULTS.corners : !!s.corners,
      band: s.band === undefined ? DEFAULTS.band : !!s.band,
      zones: s.zones === undefined ? DEFAULTS.zones : !!s.zones,
    };
    out.template = out.template.slice(0, MAX_TEMPLATE_CHARS);
    out.recipient = out.recipient.replace(/\s+/g, " ").trim().slice(0, MAX_RECIPIENT_CHARS);
    return out;
  }

  // Characters Helvetica can draw through pdf-lib's WinAnsi encoding. Anything else would make
  // pdf-lib throw, so it is replaced with "?" and the person is told.
  var WINANSI_EXTRA = [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
    0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
    0x0153, 0x017e, 0x0178,
  ];
  var WINANSI_SET = {};
  WINANSI_EXTRA.forEach(function (c) {
    WINANSI_SET[c] = true;
  });

  function drawable(cp) {
    return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0xff) || WINANSI_SET[cp] === true;
  }

  /** Returns { text, replaced } where replaced counts the characters that could not be drawn. */
  function sanitize(text) {
    var out = "";
    var replaced = 0;
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp === 0x0a || cp === 0x0d || cp === 0x09) {
        out += " ";
      } else if (drawable(cp)) {
        out += String.fromCodePoint(cp);
      } else {
        out += "?";
        replaced++;
      }
    }
    return { text: out, replaced: replaced };
  }

  /** Fills {UID}, {DATE}, {RECIPIENT}, {PAGE} and {PAGES}. Other braces are left alone. */
  function fill(template, vars) {
    return String(template).replace(/\{(UID|DATE|RECIPIENT|PAGE|PAGES)\}/g, function (_, k) {
      return vars[k] === undefined ? "" : String(vars[k]);
    });
  }

  // ------------------------------------------------------------------ ids and hashes

  var B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  function base32(bytes) {
    var out = "";
    var bits = 0;
    var value = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += B32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
      value &= (1 << bits) - 1;
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return s;
  }

  /** 50 random bits as ten characters, a dash, then four characters of the file's fingerprint. */
  function makeUid(randomBytes, fingerprintHex) {
    return base32(randomBytes).slice(0, 10) + "-" + String(fingerprintHex).slice(0, 4).toUpperCase();
  }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  async function sha256Hex(bytes) {
    var d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return toHex(new Uint8Array(d));
  }

  function isoDate(d) {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  // ------------------------------------------------------------------ geometry

  /**
   * Maps visual points to the page's own space for a page of size w x h with /Rotate `rotation`.
   * Returns { vw, vh, toPage(vx, vy, angle) -> { x, y, angle } }.
   */
  function frame(rotation, w, h) {
    var R = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
    if (R === 90) {
      return {
        vw: h, vh: w, angle: 90,
        toPage: function (vx, vy, a) { return { x: w - vy, y: vx, angle: a + 90 }; },
      };
    }
    if (R === 180) {
      return {
        vw: w, vh: h, angle: 180,
        toPage: function (vx, vy, a) { return { x: w - vx, y: h - vy, angle: a + 180 }; },
      };
    }
    if (R === 270) {
      return {
        vw: h, vh: w, angle: 270,
        toPage: function (vx, vy, a) { return { x: vy, y: h - vx, angle: a + 270 }; },
      };
    }
    return {
      vw: w, vh: h, angle: 0,
      toPage: function (vx, vy, a) { return { x: vx, y: vy, angle: a }; },
    };
  }

  /**
   * Origins (bottom left of each tile of text) that cover a vw x vh page when tiles of
   * textW x textH are laid in a grid turned by angleDeg, every other row shifted by half a tile.
   * Tiles that would not touch the page are left out. Returns the origins in visual space.
   */
  function tileOrigins(vw, vh, textW, textH, gap, angleDeg) {
    var a = (angleDeg * Math.PI) / 180;
    var c = Math.cos(a);
    var s = Math.sin(a);
    var corners = [[0, 0], [vw, 0], [0, vh], [vw, vh]];
    var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    corners.forEach(function (p) {
      var u = p[0] * c + p[1] * s;
      var v = -p[0] * s + p[1] * c;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    });
    var stepU = textW + gap;
    var stepV = textH + gap;
    var out = [];
    var j0 = Math.floor((vmin - textH) / stepV);
    var j1 = Math.ceil(vmax / stepV);
    for (var j = j0; j <= j1; j++) {
      var v0 = j * stepV;
      var shift = ((j % 2) + 2) % 2 ? stepU / 2 : 0;
      var i0 = Math.floor((umin - textW - shift) / stepU);
      var i1 = Math.ceil((umax - shift) / stepU);
      for (var i = i0; i <= i1; i++) {
        var u0 = i * stepU + shift;
        var ox = u0 * c - v0 * s;
        var oy = u0 * s + v0 * c;
        // Corners of the tile's box.
        var xs = [ox, ox + textW * c, ox - textH * s, ox + textW * c - textH * s];
        var ys = [oy, oy + textW * s, oy + textH * c, oy + textW * s + textH * c];
        var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
        var miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
        if (maxx < 0 || minx > vw || maxy < 0 || miny > vh) continue;
        out.push({ x: ox, y: oy });
      }
    }
    return out;
  }

  /**
   * The tiles for one page. With `zones`, the bottom quarter of the page (where the machine
   * readable lines of a passport sit) gets tiles twice as close together. The gap grows until
   * the page has at most MAX_TILES_PER_PAGE tiles, so a tiny font cannot make a huge file.
   * Returns { tiles, gap, zoneY }.
   */
  function pageTiles(vw, vh, textW, textH, gap, angleDeg, zones) {
    var g = gap;
    for (var tries = 0; tries < 40; tries++) {
      var base = tileOrigins(vw, vh, textW, textH, g, angleDeg);
      var zoneY = zones ? vh * ZONE_FRACTION : 0;
      var tiles = base;
      if (zones) {
        var dense = tileOrigins(vw, vh, textW, textH, g / 2, angleDeg);
        tiles = base
          .filter(function (t) { return t.y >= zoneY; })
          .concat(dense.filter(function (t) { return t.y < zoneY; }));
      }
      if (tiles.length <= MAX_TILES_PER_PAGE) return { tiles: tiles, gap: g, zoneY: zoneY };
      g = g * 1.25 + 1;
    }
    throw WatermarkError("too_dense", "The watermark has too many tiles. Use a larger font or more spacing.");
  }

  // ------------------------------------------------------------------ zip (stored, no compression)

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** A file name that is safe inside a zip and on disk: one path part, no control characters. */
  function safeFileName(name, fallback) {
    var last = String(name).split(/[\\/]/).pop();
    var cleaned = last
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "");
    if (!cleaned) return fallback || "file";
    if (cleaned.length > 120) {
      var dot = cleaned.lastIndexOf(".");
      var ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
      cleaned = cleaned.slice(0, 120 - ext.length) + ext;
    }
    return cleaned;
  }

  /**
   * A zip file holding `entries` ({ name, bytes }) with no compression. PDFs are already
   * compressed, and storing them keeps the writer short enough to read. Names are made safe
   * and unique. Throws if the archive would need zip64.
   */
  function makeZip(entries, when) {
    if (entries.length > MAX_ZIP_ENTRIES) throw WatermarkError("zip_too_large", "Too many files for one zip.");
    var enc = new TextEncoder();
    var d = when || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var used = {};
    var parts = [];
    var central = [];
    var offset = 0;
    entries.forEach(function (e, idx) {
      var name = safeFileName(e.name, "file-" + (idx + 1));
      var n = 1;
      var stem = name;
      while (used[name.toLowerCase()]) {
        n++;
        var dot = stem.lastIndexOf(".");
        name = dot > 0 ? stem.slice(0, dot) + "-" + n + stem.slice(dot) : stem + "-" + n;
      }
      used[name.toLowerCase()] = true;
      var nameBytes = enc.encode(name);
      var data = e.bytes;
      var crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);
      var cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
      if (offset > MAX_ZIP_BYTES) throw WatermarkError("zip_too_large", "These files are too big for one zip.");
    });
    var cenSize = central.reduce(function (a, p) { return a + p.length; }, 0);
    if (offset + cenSize + 22 > MAX_ZIP_BYTES) throw WatermarkError("zip_too_large", "These files are too big for one zip.");
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var out = new Uint8Array(offset + cenSize + 22);
    var pos = 0;
    all.forEach(function (p) {
      out.set(p, pos);
      pos += p.length;
    });
    return out;
  }

  // ------------------------------------------------------------------ the watermark

  function looksLikePdf(bytes) {
    var head = "";
    var n = Math.min(bytes.length, 1024);
    for (var i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
    return head.indexOf("%PDF-") !== -1;
  }

  function outputName(originalName, uid, taken) {
    var base = safeFileName(originalName, "document").replace(/\.pdf$/i, "") || "document";
    var name = base + "-watermarked.pdf";
    if (taken && taken[name.toLowerCase()]) name = base + "-" + uid + "-watermarked.pdf";
    return name;
  }

  function sleep0() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  /**
   * Watermarks one PDF. `bytes` is a Uint8Array. `onProgress(done, total)` is called after each
   * page. Returns { bytes, uid, fingerprint, sha256, outputSha256, pages, replaced, date,
   * settings } where `fingerprint` is the first 12 characters of the original file's SHA-256.
   * Throws a WatermarkError with code not_pdf, too_large, no_recipient, encrypted, invalid,
   * no_pages or too_dense.
   */
  async function watermark(PDFLib, bytes, rawSettings, onProgress, now) {
    var settings = normalizeSettings(rawSettings);
    if (!settings.recipient) {
      throw WatermarkError("no_recipient", "Enter who this copy is for. It goes on every page.");
    }
    if (bytes.length > MAX_FILE_BYTES) throw WatermarkError("too_large", "This file is larger than 200 MB.");
    if (!looksLikePdf(bytes)) throw WatermarkError("not_pdf", "This is not a PDF file.");

    var when = now || new Date();
    var date = isoDate(when);
    var sha = await sha256Hex(bytes);
    var fingerprint = sha.slice(0, 12);
    var uid = makeUid(randomBytes(8), sha);

    var doc;
    try {
      doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      var msg = e && e.message ? String(e.message) : "";
      if (/encrypt/i.test(msg)) {
        throw WatermarkError("encrypted", "This PDF is password protected. Remove the password first, then try again.");
      }
      throw WatermarkError("invalid", "This file could not be read as a PDF.");
    }
    var pages;
    try {
      pages = doc.getPages();
    } catch (e) {
      throw WatermarkError("invalid", "This file could not be read as a PDF.");
    }
    if (pages.length === 0) throw WatermarkError("no_pages", "This PDF has no pages.");

    var font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    var rgb = PDFLib.rgb;
    var degrees = PDFLib.degrees;
    var col = COLORS[settings.color];
    var tint = rgb(col[0], col[1], col[2]);
    var replaced = 0;

    function clean(t) {
      var r = sanitize(t);
      replaced += r.replaced;
      return r.text;
    }
    var recipientText = clean(settings.recipient);
    var total = pages.length;

    for (var p = 0; p < total; p++) {
      var page = pages[p];
      var box = page.getMediaBox();
      var fr = frame(page.getRotation().angle, box.width, box.height);
      var vars = { UID: uid, DATE: date, RECIPIENT: recipientText, PAGE: p + 1, PAGES: total };

      // Draws text at a visual position and angle.
      var text = function (str, vx, vy, a, size, color, opacity) {
        var m = fr.toPage(vx, vy, a);
        page.drawText(str, {
          x: box.x + m.x, y: box.y + m.y, size: size, font: font, color: color, opacity: opacity,
          rotate: degrees(m.angle),
        });
      };
      var rect = function (vx, vy, w, h, color, opacity) {
        var m = fr.toPage(vx, vy, 0);
        page.drawRectangle({
          x: box.x + m.x, y: box.y + m.y, width: w, height: h, color: color, opacity: opacity,
          rotate: degrees(m.angle),
        });
      };

      var line = clean(fill(settings.template, vars));
      var tw = font.widthOfTextAtSize(line, settings.fontSize);
      var th = settings.fontSize;
      var layout = pageTiles(fr.vw, fr.vh, tw, th, settings.spacing, settings.rotation, settings.zones);
      for (var t = 0; t < layout.tiles.length; t++) {
        text(line, layout.tiles[t].x, layout.tiles[t].y, settings.rotation, settings.fontSize, tint, settings.opacity);
      }

      var bandTop = 0;
      if (settings.band) {
        bandTop = BAND_HEIGHT;
        var bandText = clean("Shared with: " + settings.recipient + " • " + uid);
        var bs = 10;
        var bw = font.widthOfTextAtSize(bandText, bs);
        rect(0, 0, fr.vw, BAND_HEIGHT, rgb(0.92, 0.92, 0.92), 0.85);
        text(bandText, Math.max(6, (fr.vw - bw) / 2), 8, 0, bs, rgb(0.1, 0.1, 0.1), 1);
      }

      if (settings.corners) {
        var stamp = clean(uid + " • Page " + (p + 1) + " of " + total);
        var ss = 8;
        var sw = font.widthOfTextAtSize(stamp, ss);
        rect(6, fr.vh - 16, sw + 8, 12, rgb(1, 1, 1), 0.75);
        text(stamp, 10, fr.vh - 13, 0, ss, rgb(0, 0, 0), 0.9);
        rect(fr.vw - sw - 14, bandTop + 4, sw + 8, 12, rgb(1, 1, 1), 0.75);
        text(stamp, fr.vw - sw - 10, bandTop + 7, 0, ss, rgb(0, 0, 0), 0.9);
      }

      // Near invisible copies of the id. They can be found by selecting text or searching, and
      // they are lost when the page is printed or photographed.
      var hidden = clean(uid + " p" + (p + 1));
      text(hidden, 3, 3, 0, 1, rgb(0, 0, 0), 0.01);
      text(hidden, fr.vw / 2, fr.vh / 2, 0, 1, rgb(0, 0, 0), 0.01);
      text(hidden, Math.max(3, fr.vw - 40), fr.vh - 4, 0, 1, rgb(0, 0, 0), 0.01);

      if (onProgress) onProgress(p + 1, total);
      if (p % 3 === 2) await sleep0();
    }

    var info = doc.getInfoDict();
    var N = PDFLib.PDFName;
    var H = PDFLib.PDFHexString;
    info.set(N.of("ETSWatermarkID"), H.fromText(uid));
    info.set(N.of("ETSWatermarkFingerprint"), H.fromText(fingerprint));
    info.set(N.of("ETSWatermarkRecipient"), H.fromText(recipientText));
    info.set(N.of("ETSWatermarkDate"), H.fromText(date));
    var kw = doc.getKeywords();
    doc.setKeywords((kw ? [kw] : []).concat(["watermarked", uid, fingerprint]));
    doc.setProducer(TOOL_NAME + " " + VERSION + " (Sanctum)");
    doc.setModificationDate(when);

    var out = await doc.save();
    var outSha = await sha256Hex(out);
    return {
      bytes: out, uid: uid, fingerprint: fingerprint, sha256: sha, outputSha256: outSha,
      pages: total, replaced: replaced, date: date, settings: settings,
    };
  }

  /** The record that goes in the zip. It holds no document content. */
  function receipt(items, when) {
    return JSON.stringify(
      {
        tool: TOOL_NAME,
        version: VERSION,
        createdAt: (when || new Date()).toISOString(),
        note: "Deterrence, not protection. This record holds no document content.",
        files: items.map(function (i) {
          return {
            output: i.outputName,
            original: i.originalName,
            uid: i.uid,
            recipient: i.settings.recipient,
            date: i.date,
            pages: i.pages,
            originalSha256: i.sha256,
            outputSha256: i.outputSha256,
            settings: {
              template: i.settings.template, color: i.settings.color, opacity: i.settings.opacity,
              rotation: i.settings.rotation, fontSize: i.settings.fontSize, spacing: i.settings.spacing,
              corners: i.settings.corners, band: i.settings.band, zones: i.settings.zones,
            },
          };
        }),
      },
      null,
      2
    );
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }

  var api = {
    VERSION: VERSION,
    TOOL_NAME: TOOL_NAME,
    DEFAULTS: DEFAULTS,
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    COLORS: COLORS,
    LIMITS: LIMITS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_TILES_PER_PAGE: MAX_TILES_PER_PAGE,
    MAX_RECIPIENT_CHARS: MAX_RECIPIENT_CHARS,
    MAX_TEMPLATE_CHARS: MAX_TEMPLATE_CHARS,
    BAND_HEIGHT: BAND_HEIGHT,
    ZONE_FRACTION: ZONE_FRACTION,
    normalizeSettings: normalizeSettings,
    sanitize: sanitize,
    fill: fill,
    base32: base32,
    makeUid: makeUid,
    sha256Hex: sha256Hex,
    isoDate: isoDate,
    frame: frame,
    tileOrigins: tileOrigins,
    pageTiles: pageTiles,
    crc32: crc32,
    safeFileName: safeFileName,
    makeZip: makeZip,
    looksLikePdf: looksLikePdf,
    outputName: outputName,
    watermark: watermark,
    receipt: receipt,
    formatBytes: formatBytes,
    WatermarkError: WatermarkError,
  };

  globalThis.WatermarkCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
