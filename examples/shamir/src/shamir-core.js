/*
 * Shamir secret sharing core for the Sanctum example tool.
 *
 * Plain script: no DOM, no imports, no network, no dynamic code. Synchronous.
 * It sets globalThis.ShamirCore and, under Node, module.exports.
 * The only platform dependencies are globalThis.crypto.getRandomValues,
 * TextEncoder and TextDecoder.
 *
 * Maths: Shamir's scheme over GF(256) with modulus 0x11b. The exp and log
 * tables are built at load time from the generator 3.
 * Formats and rules follow the project spec: "ss1" (self-describing, with a
 * check value inside the shared payload) and "plain" (bare shares in the
 * token-NN-hex layout used by ssss-made-easy and shamir-secret-sharing).
 *
 * Credit: the feature set follows ssss-made-easy (Martin Carpella, 0xjjpa;
 * GPL-3.0). The share layout matches shamir-secret-sharing (Apache-2.0) and
 * the HashiCorp Vault shamir package. This file was written from the spec,
 * without copying their code or tables.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants

  var PAD_CHOICES = Object.freeze([0, 16, 32, 64, 128, 256]);

  var LIMITS = Object.freeze({
    MIN_SHARES: 2,
    MAX_SHARES: 255,
    MIN_THRESHOLD: 2,
    MAX_SECRET_BYTES: 1024,
    MAX_LABEL_CHARS: 32,
    PAD_CHOICES: PAD_CHOICES,
    GENERATOR_ALPHABET: "ABCDEFGHJKMNPQRTUVWXYZ234679",
  });

  // 1 to 32 label characters, and no dash-delimited segment equal to ss1 in any case.
  var LABEL_PATTERN = /^(?!(?:[A-Za-z0-9._-]*-)?[Ss][Ss]1(?:-|$))[A-Za-z0-9._-]{1,32}$/;

  var TAG_DOMAIN = asciiBytes("sanctum-shamir/v1/tag");
  var CHK_DOMAIN = asciiBytes("sanctum-shamir/v1/share");

  var MESSAGES = {
    SECRET_EMPTY: "The secret is empty.",
    SECRET_TOO_LONG: "The secret is too long.",
    BAD_SHARE_COUNT: "The number of shares must be a whole number from 2 to 255.",
    BAD_THRESHOLD: "The threshold is not valid.",
    BAD_OPTION: "An option is not valid.",
    RANDOM_UNAVAILABLE: "No secure random source is available.",
    EMPTY_INPUT: "Nothing to read.",
    BAD_SYNTAX: "This does not look like a share.",
    BAD_HEX: "The share has a non-hex character or an odd number of digits.",
    SHARE_TOO_SHORT: "The share is too short.",
    X_OUT_OF_RANGE: "The share position is out of range.",
    BAD_CHECKSUM: "The share checksum does not match.",
    NO_SHARES: "No shares were given.",
    MIXED_FORMATS: "Shares of different formats cannot be combined.",
    MIXED_SETS: "The shares come from different splits.",
    LENGTH_MISMATCH: "The shares have different lengths.",
    DUPLICATE_X: "Two different shares claim the same position.",
    NOT_ENOUGH_SHARES: "Not enough shares.",
    INCONSISTENT_SHARES: "A share does not agree with the others.",
    INTEGRITY_FAILED: "The shares did not rebuild a valid secret.",
  };

  // ------------------------------------------------------------------- errors

  class ShamirError extends Error {
    constructor(code, details, message) {
      super(message || MESSAGES[code] || code);
      this.name = "ShamirError";
      this.code = code;
      this.details = Object.freeze(details ? Object.assign({}, details) : {});
    }
  }

  function fail(code, details, message) {
    throw new ShamirError(code, details, message);
  }

  // ------------------------------------------------------------------ helpers

  function asciiBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function concat(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], pos);
      pos += parts[i].length;
    }
    return out;
  }

  var HEX_CHARS = "0123456789abcdef";
  var HEX_PAIRS = (function () {
    var t = new Array(256);
    for (var i = 0; i < 256; i++) t[i] = HEX_CHARS[i >> 4] + HEX_CHARS[i & 15];
    return t;
  })();

  function toHex(bytes) {
    var parts = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) parts[i] = HEX_PAIRS[bytes[i]];
    return parts.join("");
  }

  function hexValue(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
  }

  function fromHex(hex) {
    if (typeof hex !== "string") fail("BAD_HEX", { reason: "not a string" });
    if (hex.length % 2 !== 0) fail("BAD_HEX", { reason: "odd length" });
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      var hi = hexValue(hex.charCodeAt(2 * i));
      var lo = hexValue(hex.charCodeAt(2 * i + 1));
      if (hi < 0 || lo < 0) fail("BAD_HEX", { reason: "non-hex character", position: 2 * i });
      out[i] = (hi << 4) | lo;
    }
    return out;
  }

  function utf8Encode(text) {
    return new TextEncoder().encode(text);
  }

  function utf8Decode(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function isBytes(x) {
    return x instanceof Uint8Array || Object.prototype.toString.call(x) === "[object Uint8Array]";
  }

  function wipe(bytes) {
    if (bytes && typeof bytes.fill === "function") bytes.fill(0);
  }

  function isValidLabel(label) {
    return typeof label === "string" && LABEL_PATTERN.test(label);
  }

  function entropyBits(length) {
    return length * Math.log2(LIMITS.GENERATOR_ALPHABET.length);
  }

  // ------------------------------------------------------------------- SHA-256

  var SHA_K = new Uint32Array(64);
  var SHA_H0 = new Uint32Array(8);
  (function () {
    var primes = [];
    for (var c = 2; primes.length < 64; c++) {
      var isPrime = true;
      for (var d = 2; d * d <= c; d++) {
        if (c % d === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) primes.push(c);
    }
    function frac32(v) {
      return Math.floor((v - Math.floor(v)) * 4294967296) >>> 0;
    }
    var i;
    for (i = 0; i < 64; i++) SHA_K[i] = frac32(Math.cbrt(primes[i]));
    for (i = 0; i < 8; i++) SHA_H0[i] = frac32(Math.sqrt(primes[i]));
  })();

  function sha256(bytes) {
    var len = bytes.length;
    var padded = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(padded);
    buf.set(bytes, 0);
    buf[len] = 0x80;
    var view = new DataView(buf.buffer);
    view.setUint32(padded - 8, Math.floor(len / 536870912), false);
    view.setUint32(padded - 4, (len << 3) >>> 0, false);

    var h = new Uint32Array(SHA_H0);
    var w = new Uint32Array(64);
    for (var off = 0; off < padded; off += 64) {
      var t;
      for (t = 0; t < 16; t++) w[t] = view.getUint32(off + 4 * t, false);
      for (t = 16; t < 64; t++) {
        var x15 = w[t - 15];
        var x2 = w[t - 2];
        var s0 = ((x15 >>> 7) | (x15 << 25)) ^ ((x15 >>> 18) | (x15 << 14)) ^ (x15 >>> 3);
        var s1 = ((x2 >>> 17) | (x2 << 15)) ^ ((x2 >>> 19) | (x2 << 13)) ^ (x2 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + SHA_K[t] + w[t]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }
    var out = new Uint8Array(32);
    var ov = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) ov.setUint32(4 * i, h[i], false);
    wipe(buf);
    wipe(w);
    return out;
  }

  // -------------------------------------------------------------------- GF(256)

  var EXP = new Uint8Array(510);
  var LOG = new Uint8Array(256);
  (function () {
    var e = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = e;
      LOG[e] = i;
      var twice = ((e << 1) ^ (e & 0x80 ? 0x1b : 0)) & 0xff;
      e = e ^ twice; // multiply by the generator 3
    }
    for (var j = 255; j < 510; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function gfInv(a) {
    if (a === 0) throw new RangeError("zero has no inverse");
    return EXP[255 - LOG[a]];
  }

  // Lagrange weights for evaluating at `target`, given distinct nonzero xs.
  // Every factor (target xor x_j) and (x_i xor x_j) is nonzero in our uses:
  // target is 0 or an x that differs from all the xs.
  function lagrangeLogWeights(xs, target) {
    var k = xs.length;
    var out = new Uint16Array(k);
    for (var i = 0; i < k; i++) {
      var acc = 0;
      for (var j = 0; j < k; j++) {
        if (j === i) continue;
        acc += LOG[target ^ xs[j]] + 255 - LOG[xs[i] ^ xs[j]];
      }
      out[i] = acc % 255;
    }
    return out;
  }

  // Value at `target` of the polynomial through the given raw shares (y bytes then x).
  function interpolate(raws, target) {
    var k = raws.length;
    var L = raws[0].length - 1;
    var xs = new Uint8Array(k);
    for (var i = 0; i < k; i++) xs[i] = raws[i][L];
    var lw = lagrangeLogWeights(xs, target);
    var out = new Uint8Array(L);
    for (var b = 0; b < L; b++) {
      var acc = 0;
      for (var s = 0; s < k; s++) {
        var y = raws[s][b];
        if (y !== 0) acc ^= EXP[LOG[y] + lw[s]];
      }
      out[b] = acc;
    }
    return out;
  }

  // ------------------------------------------------------------------- random

  function defaultRandomBytes(n) {
    var c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== "function") fail("RANDOM_UNAVAILABLE");
    var out = new Uint8Array(n);
    for (var off = 0; off < n; off += 65536) {
      c.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
    }
    return out;
  }

  function checkedDraw(source, n) {
    var bytes = source(n);
    if (!isBytes(bytes) || bytes.length !== n) {
      fail("BAD_OPTION", { option: "randomBytes", reason: "must return exactly " + n + " bytes" });
    }
    return bytes;
  }

  function randomSecret(opts) {
    var o = opts || {};
    var length = o.length === undefined ? 32 : o.length;
    if (!Number.isInteger(length) || length < 8 || length > 128) {
      fail("BAD_OPTION", { option: "length", min: 8, max: 128, have: length });
    }
    var source;
    if (o.randomBytes !== undefined) {
      if (typeof o.randomBytes !== "function") fail("BAD_OPTION", { option: "randomBytes" });
      source = o.randomBytes;
    } else {
      var c = globalThis.crypto;
      if (!c || typeof c.getRandomValues !== "function") fail("RANDOM_UNAVAILABLE");
      source = defaultRandomBytes;
    }
    var alphabet = LIMITS.GENERATOR_ALPHABET;
    var m = alphabet.length;
    var limit = m * Math.floor(256 / m); // 252
    var out = "";
    while (out.length < length) {
      var batch = checkedDraw(source, length - out.length);
      for (var i = 0; i < batch.length && out.length < length; i++) {
        if (batch[i] < limit) out += alphabet[batch[i] % m];
      }
      if (source === defaultRandomBytes) wipe(batch);
    }
    return out;
  }

  // ------------------------------------------------------------ share objects

  function makeShare(format, label, threshold, setId, body) {
    var x = body[body.length - 1];
    var text;
    if (format === "ss1") {
      var chk = checksum(threshold, fromHex(setId), body);
      text = "ss1-" + threshold + "-" + setId + "-" + toHex(body) + "-" + chk;
    } else {
      text = (x < 10 ? "0" : "") + x + "-" + toHex(body);
    }
    if (label) text = label + "-" + text;
    return Object.freeze({
      format: format,
      label: label || null,
      x: x,
      threshold: format === "ss1" ? threshold : null,
      setId: format === "ss1" ? setId : null,
      body: body,
      text: text,
    });
  }

  function checksum(k, setIdBytes, body) {
    var d = sha256(concat([CHK_DOMAIN, Uint8Array.of(k), setIdBytes, body]));
    return toHex(d.subarray(0, 2));
  }

  function makeTag(lenBytes, secret) {
    return sha256(concat([TAG_DOMAIN, lenBytes, secret])).subarray(0, 4);
  }

  // -------------------------------------------------------------------- split

  function split(secret, n, k, options) {
    if (!isBytes(secret)) fail("BAD_OPTION", { option: "secret" }, "The secret must be a Uint8Array.");
    if (secret.length === 0) fail("SECRET_EMPTY");
    if (secret.length > LIMITS.MAX_SECRET_BYTES) {
      fail("SECRET_TOO_LONG", { max: LIMITS.MAX_SECRET_BYTES, have: secret.length });
    }
    if (!Number.isInteger(n) || n < LIMITS.MIN_SHARES || n > LIMITS.MAX_SHARES) {
      fail("BAD_SHARE_COUNT", { min: LIMITS.MIN_SHARES, max: LIMITS.MAX_SHARES, have: n });
    }
    if (!Number.isInteger(k) || k < LIMITS.MIN_THRESHOLD || k > n) {
      fail("BAD_THRESHOLD", { min: LIMITS.MIN_THRESHOLD, max: n, have: k });
    }

    var opt = options || {};
    var format = opt.format === undefined ? "ss1" : opt.format;
    if (format !== "ss1" && format !== "plain") fail("BAD_OPTION", { option: "format" });
    var label = opt.label === undefined || opt.label === null ? null : opt.label;
    if (label !== null && !isValidLabel(label)) fail("BAD_OPTION", { option: "label" });
    var padTo = opt.padTo === undefined ? 0 : opt.padTo;
    if (PAD_CHOICES.indexOf(padTo) < 0) fail("BAD_OPTION", { option: "padTo" });
    if (format === "plain" && padTo !== 0) fail("BAD_OPTION", { option: "padTo" });
    var source;
    var ownRandom = false;
    if (opt.randomBytes !== undefined && opt.randomBytes !== null) {
      if (typeof opt.randomBytes !== "function") fail("BAD_OPTION", { option: "randomBytes" });
      source = opt.randomBytes;
    } else {
      var c = globalThis.crypto;
      if (!c || typeof c.getRandomValues !== "function") fail("RANDOM_UNAVAILABLE");
      source = defaultRandomBytes;
      ownRandom = true;
    }

    // Payload: the secret itself (plain) or LEN || secret || zero padding || TAG (ss1).
    var setId = null;
    var payload;
    if (format === "ss1") {
      var idBytes = checkedDraw(source, 4);
      setId = toHex(idBytes);
      if (ownRandom) wipe(idBytes);
      var L = secret.length;
      var base = 2 + L + 4;
      var total = padTo === 0 ? base : Math.ceil(base / padTo) * padTo;
      payload = new Uint8Array(total);
      payload[0] = L >> 8;
      payload[1] = L & 0xff;
      payload.set(secret, 2);
      payload.set(makeTag(payload.subarray(0, 2), secret), total - 4);
    } else {
      payload = new Uint8Array(secret);
    }

    var P = payload.length;
    var km1 = k - 1;
    var rand = checkedDraw(source, P * km1);

    var bodies = new Array(n);
    var tbl = new Uint8Array(256);
    for (var s = 0; s < n; s++) {
      var x = s + 1;
      var lx = LOG[x];
      tbl[0] = 0;
      for (var v = 1; v < 256; v++) tbl[v] = EXP[LOG[v] + lx];
      var body = new Uint8Array(P + 1);
      for (var i = 0; i < P; i++) {
        var off = i * km1;
        var r = rand[off + km1 - 1];
        for (var j = km1 - 2; j >= 0; j--) r = tbl[r] ^ rand[off + j];
        body[i] = tbl[r] ^ payload[i];
      }
      body[P] = x;
      bodies[s] = body;
    }

    var shares = new Array(n);
    for (var q = 0; q < n; q++) shares[q] = makeShare(format, label, k, setId, bodies[q]);

    wipe(payload);
    wipe(tbl);
    if (ownRandom) wipe(rand);

    return Object.freeze({
      shares: Object.freeze(shares),
      format: format,
      threshold: k,
      setId: setId,
      payloadBytes: P,
    });
  }

  // -------------------------------------------------------------------- parse

  var SS1_RE = /^(?:([A-Za-z0-9._-]{1,32})-)?ss1-(\d{1,3})-([0-9a-f]{8})-([0-9a-f]+)-([0-9a-f]{4})$/i;
  var HEX_ONLY_RE = /^[0-9a-f]+$/i;
  // A plain prefix is `[label-]NN` (the label may be empty, as the original site produces),
  // or a bare label with no dashes. Anything else is refused: a looser rule let a damaged
  // ss1 share (for example one with a mistyped "ss1" tag) parse as a tiny plain share.
  var PLAIN_HEAD_RE = /^(?:([A-Za-z0-9._-]{0,32})-)?(\d{1,3})$/;
  var PLAIN_BARE_LABEL_RE = /^[A-Za-z0-9._]{1,32}$/;

  function parseShare(text) {
    if (typeof text !== "string") fail("EMPTY_INPUT", { reason: "not a string" });
    var t = text.trim();
    if (t === "") fail("EMPTY_INPUT");

    var m = SS1_RE.exec(t);
    if (m) {
      var k = parseInt(m[2], 10);
      if (k < 2 || k > 255 || String(k) !== m[2]) fail("BAD_THRESHOLD", { have: m[2] });
      var bodyHex = m[4];
      if (bodyHex.length % 2 !== 0) fail("BAD_HEX", { reason: "odd length" });
      var body = fromHex(bodyHex);
      if (body.length < 8) fail("SHARE_TOO_SHORT", { have: body.length, min: 8 });
      if (body[body.length - 1] === 0) fail("X_OUT_OF_RANGE");
      var setId = m[3].toLowerCase();
      if (checksum(k, fromHex(setId), body) !== m[5].toLowerCase()) fail("BAD_CHECKSUM");
      return makeShare("ss1", m[1] || null, k, setId, body);
    }

    var segs = t.split("-");
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].toLowerCase() === "ss1") fail("BAD_SYNTAX", { reason: "damaged ss1 share" });
    }

    var head = "";
    var tail = t;
    var cut = t.lastIndexOf("-");
    if (cut >= 0) {
      head = t.slice(0, cut);
      tail = t.slice(cut + 1);
    }
    if (tail === "") fail("BAD_SYNTAX", { reason: "empty body" });
    if (!HEX_ONLY_RE.test(tail) || tail.length % 2 !== 0) fail("BAD_HEX");
    var pbody = fromHex(tail);
    if (pbody.length < 2) fail("SHARE_TOO_SHORT", { have: pbody.length, min: 2 });
    if (pbody[pbody.length - 1] === 0) fail("X_OUT_OF_RANGE");

    var label = null;
    if (head !== "") {
      var hm = PLAIN_HEAD_RE.exec(head);
      if (hm) {
        label = hm[1] || null;
      } else if (PLAIN_BARE_LABEL_RE.test(head)) {
        label = head;
      } else {
        fail("BAD_SYNTAX", { reason: "unrecognised share prefix" });
      }
    }
    return makeShare("plain", label, null, null, pbody);
  }

  function parseShares(text) {
    var out = [];
    if (typeof text !== "string") return out;
    var pieces = text.split(/\s+/);
    for (var i = 0; i < pieces.length; i++) {
      if (pieces[i] === "") continue;
      var index = out.length;
      try {
        out.push(Object.freeze({ index: index, raw: pieces[i], share: parseShare(pieces[i]), error: null }));
      } catch (e) {
        if (!(e instanceof ShamirError)) throw e;
        out.push(
          Object.freeze({
            index: index,
            raw: pieces[i],
            share: null,
            error: Object.freeze({ code: e.code, message: e.message }),
          })
        );
      }
    }
    return out;
  }

  // Turn an input list into [{ share, idx }]. With `strict`, a parse failure
  // throws with details.index. Otherwise failures are skipped.
  function prepare(list, strict) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var share = null;
      if (typeof item === "string") {
        try {
          share = parseShare(item);
        } catch (e) {
          if (!(e instanceof ShamirError)) throw e;
          if (strict) fail(e.code, Object.assign({}, e.details, { index: i }), e.message);
        }
      } else if (item && isBytes(item.body) && (item.format === "ss1" || item.format === "plain")) {
        share = item;
      } else if (strict) {
        fail("BAD_SYNTAX", { index: i, reason: "not a share" });
      }
      if (share) out.push({ share: share, idx: i });
    }
    return out;
  }

  function dedupe(entries) {
    var seen = Object.create(null);
    var uniq = [];
    var dups = 0;
    for (var i = 0; i < entries.length; i++) {
      var s = entries[i].share;
      var key = s.format + ":" + (s.setId || "") + ":" + (s.threshold || 0) + ":" + s.x + ":" + toHex(s.body);
      if (seen[key]) {
        dups++;
        continue;
      }
      seen[key] = true;
      uniq.push(entries[i]);
    }
    return { uniq: uniq, dups: dups };
  }

  function validThreshold(t) {
    return Number.isInteger(t) && t >= 2 && t <= 255;
  }

  // ----------------------------------------------------------------- validate

  function validateShares(shares, options) {
    var list = prepare(shares || [], false);
    var problems = [];
    var optT = options && validThreshold(options.threshold) ? options.threshold : null;

    if (list.length === 0) {
      return Object.freeze({
        format: null,
        setId: null,
        threshold: null,
        count: 0,
        ignoredDuplicates: 0,
        needed: null,
        missing: 0,
        canCombine: false,
        problems: Object.freeze([]),
      });
    }

    var first = list[0].share;
    var formats = Object.create(null);
    var i;
    for (i = 0; i < list.length; i++) formats[list[i].share.format] = true;
    var mixedFormats = Object.keys(formats).length > 1;
    var format = mixedFormats ? "mixed" : first.format;

    var dd = dedupe(list);
    var uniq = dd.uniq;
    var bad;

    if (mixedFormats) {
      bad = [];
      for (i = 0; i < uniq.length; i++) if (uniq[i].share.format !== first.format) bad.push(uniq[i].idx);
      problems.push({ code: "MIXED_FORMATS", indices: bad });
    }

    var setId = null;
    var threshold = null;
    var ss1s = uniq.filter(function (e) {
      return e.share.format === "ss1";
    });
    if (ss1s.length > 0) {
      var ref = ss1s[0].share;
      bad = [];
      for (i = 0; i < ss1s.length; i++) {
        if (ss1s[i].share.setId !== ref.setId || ss1s[i].share.threshold !== ref.threshold) bad.push(ss1s[i].idx);
      }
      if (bad.length > 0) problems.push({ code: "MIXED_SETS", indices: bad });
      else if (!mixedFormats) {
        setId = ref.setId;
        threshold = ref.threshold;
      }
    }

    bad = [];
    for (i = 0; i < uniq.length; i++) if (uniq[i].share.body.length !== uniq[0].share.body.length) bad.push(uniq[i].idx);
    if (bad.length > 0) problems.push({ code: "LENGTH_MISMATCH", indices: bad });

    var byX = Object.create(null);
    for (i = 0; i < uniq.length; i++) {
      var xk = uniq[i].share.x;
      (byX[xk] || (byX[xk] = [])).push(uniq[i].idx);
    }
    bad = [];
    Object.keys(byX).forEach(function (k) {
      if (byX[k].length > 1) bad = bad.concat(byX[k]);
    });
    if (bad.length > 0) {
      bad.sort(function (a, b) {
        return a - b;
      });
      problems.push({ code: "DUPLICATE_X", indices: bad });
    }

    var needed = first.format === "ss1" ? first.threshold : optT || 2;
    var count = uniq.length;
    var missing = Math.max(0, needed - count);
    if (missing > 0) problems.push({ code: "NOT_ENOUGH_SHARES", indices: [] });

    return Object.freeze({
      format: format,
      setId: setId,
      threshold: threshold,
      count: count,
      ignoredDuplicates: dd.dups,
      needed: needed,
      missing: missing,
      canCombine: problems.length === 0,
      problems: Object.freeze(
        problems.map(function (p) {
          return Object.freeze({ code: p.code, indices: p.indices });
        })
      ),
    });
  }

  // ------------------------------------------------------------------ combine

  function combine(shares, options) {
    var inputs = Array.isArray(shares) ? shares : [];
    var entries = prepare(inputs, true);
    if (entries.length === 0) fail("NO_SHARES");

    var first = entries[0].share;
    var i;
    for (i = 1; i < entries.length; i++) {
      if (entries[i].share.format !== first.format) fail("MIXED_FORMATS", { index: entries[i].idx });
    }
    var format = first.format;

    var optT = null;
    if (format === "plain" && options && options.threshold !== undefined && options.threshold !== null) {
      if (!validThreshold(options.threshold)) {
        fail("BAD_OPTION", { option: "threshold", min: 2, max: 255, have: options.threshold });
      }
      optT = options.threshold;
    }

    var dd = dedupe(entries);
    var uniq = dd.uniq;

    if (format === "ss1") {
      for (i = 1; i < uniq.length; i++) {
        if (uniq[i].share.setId !== uniq[0].share.setId || uniq[i].share.threshold !== uniq[0].share.threshold) {
          fail("MIXED_SETS", { index: uniq[i].idx });
        }
      }
    }
    for (i = 1; i < uniq.length; i++) {
      if (uniq[i].share.body.length !== uniq[0].share.body.length) fail("LENGTH_MISMATCH", { index: uniq[i].idx });
    }
    var seenX = Object.create(null);
    for (i = 0; i < uniq.length; i++) {
      var x = uniq[i].share.x;
      if (seenX[x]) fail("DUPLICATE_X", { x: x });
      seenX[x] = true;
    }

    var need = format === "ss1" ? first.threshold : optT || 2;
    if (uniq.length < need) fail("NOT_ENOUGH_SHARES", { have: uniq.length, need: need });

    var t = format === "ss1" ? need : optT || uniq.length;
    var use = uniq.slice(0, t);
    var extra = uniq.slice(t);
    var raws = use.map(function (e) {
      return e.share.body;
    });
    var payload = interpolate(raws, 0);

    var mismatched = [];
    for (i = 0; i < extra.length; i++) {
      var want = interpolate(raws, extra[i].share.x);
      var have = extra[i].share.body;
      var same = true;
      for (var b = 0; b < want.length; b++) {
        if (want[b] !== have[b]) {
          same = false;
          break;
        }
      }
      if (!same) mismatched.push(extra[i].idx);
    }

    if (format === "plain") {
      if (mismatched.length > 0) {
        wipe(payload);
        fail("INCONSISTENT_SHARES", { indices: mismatched });
      }
      return Object.freeze({
        secret: payload,
        format: "plain",
        threshold: optT,
        setId: null,
        verified: false,
        sharesUsed: t,
        ignoredDuplicates: dd.dups,
        warnings: Object.freeze([]),
      });
    }

    // ss1: LEN(2) || secret || zero padding || TAG(4)
    var ok = payload.length >= 7;
    var ln = 0;
    if (ok) {
      ln = (payload[0] << 8) | payload[1];
      ok = ln >= 1 && 2 + ln + 4 <= payload.length;
    }
    if (ok) {
      var padEnd = payload.length - 4;
      var pad = 0;
      for (i = 2 + ln; i < padEnd; i++) pad |= payload[i];
      var tag = makeTag(payload.subarray(0, 2), payload.subarray(2, 2 + ln));
      var diff = pad;
      for (i = 0; i < 4; i++) diff |= tag[i] ^ payload[padEnd + i];
      ok = diff === 0;
    }
    if (!ok) {
      wipe(payload);
      fail("INTEGRITY_FAILED", { extraMismatch: mismatched });
    }
    var secret = payload.slice(2, 2 + ln);
    wipe(payload);
    return Object.freeze({
      secret: secret,
      format: "ss1",
      threshold: first.threshold,
      setId: first.setId,
      verified: true,
      sharesUsed: t,
      ignoredDuplicates: dd.dups,
      warnings: Object.freeze(
        mismatched.length > 0 ? [Object.freeze({ code: "EXTRA_SHARE_MISMATCH", inputIndices: mismatched })] : []
      ),
    });
  }

  // ------------------------------------------------------------------- export

  var api = Object.freeze({
    LIMITS: LIMITS,
    LABEL_PATTERN: LABEL_PATTERN,
    ShamirError: ShamirError,
    split: split,
    parseShare: parseShare,
    parseShares: parseShares,
    validateShares: validateShares,
    combine: combine,
    toHex: toHex,
    fromHex: fromHex,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    sha256: sha256,
    randomSecret: randomSecret,
    entropyBits: entropyBits,
    isValidLabel: isValidLabel,
    wipe: wipe,
    gf256: Object.freeze({ mul: gfMul, inv: gfInv }),
  });

  globalThis.ShamirCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
