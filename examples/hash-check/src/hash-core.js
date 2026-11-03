/*
 * Hash Check core for the Sanctum example tool.
 *
 * Plain script: no DOM, no imports, no network, no dynamic code. Synchronous.
 * It sets globalThis.HashCore and, under Node, module.exports.
 *
 * SHA-256, SHA-384 and SHA-512 (FIPS 180-4) with a streaming interface, so a file of any
 * size can be read in pieces. The constants are not typed in: they are the fractional parts
 * of the square and cube roots of the first primes, computed once at load with BigInt, as
 * the standard defines them. The known answers in the test folder prove the result.
 * SHA-512 works on pairs of 32-bit words because 64-bit integers are slow in a browser.
 *
 * Also reads the text people paste: a bare checksum, "sha256:..." , GNU "hash  name" lines
 * and BSD "SHA256 (name) = hash" lines.
 */
(function () {
  "use strict";

  var ALGS = Object.freeze({
    sha256: Object.freeze({ id: "sha256", label: "SHA-256", hexLength: 64 }),
    sha384: Object.freeze({ id: "sha384", label: "SHA-384", hexLength: 96 }),
    sha512: Object.freeze({ id: "sha512", label: "SHA-512", hexLength: 128 }),
  });

  function HashError(code, message) {
    var e = new Error(message);
    e.name = "HashError";
    e.code = code;
    return e;
  }

  // ---------------------------------------------------------------- constants

  var MASK64 = (1n << 64n) - 1n;

  function primes(count) {
    var out = [];
    for (var n = 2; out.length < count; n++) {
      var prime = true;
      for (var i = 0; i < out.length && out[i] * out[i] <= n; i++) {
        if (n % out[i] === 0) { prime = false; break; }
      }
      if (prime) out.push(n);
    }
    return out;
  }

  // floor(n ^ (1/k)) for BigInt n, by Newton's method from above.
  function iroot(n, k) {
    if (n < 2n) return n;
    var kk = BigInt(k);
    var x = 1n << BigInt(Math.ceil(n.toString(2).length / k));
    for (;;) {
      var y = ((kk - 1n) * x + n / x ** (kk - 1n)) / kk;
      if (y >= x) return x;
      x = y;
    }
  }

  var P = primes(80);
  // Fractional part of the cube root of the first 80 primes, to 64 bits: SHA-512's K.
  var K_HI = new Uint32Array(80);
  var K_LO = new Uint32Array(80);
  for (var i = 0; i < 80; i++) {
    var kc = iroot(BigInt(P[i]) << 192n, 3) & MASK64;
    K_HI[i] = Number(kc >> 32n);
    K_LO[i] = Number(kc & 0xffffffffn);
  }
  // SHA-256 uses the top 32 bits of the first 64 of those.
  var K256 = K_HI.slice(0, 64);

  // Fractional part of the square root of a prime, to 64 bits, as [hi, lo].
  function sqrtFrac(p) {
    var v = iroot(BigInt(p) << 128n, 2) & MASK64;
    return [Number(v >> 32n), Number(v & 0xffffffffn)];
  }
  var INIT512 = new Uint32Array(16); // first 8 primes
  var INIT384 = new Uint32Array(16); // primes 9 to 16
  var INIT256 = new Uint32Array(8); // top 32 bits of the first 8 primes
  for (var j = 0; j < 8; j++) {
    var a = sqrtFrac(P[j]);
    INIT512[2 * j] = a[0];
    INIT512[2 * j + 1] = a[1];
    INIT256[j] = a[0];
    var b = sqrtFrac(P[8 + j]);
    INIT384[2 * j] = b[0];
    INIT384[2 * j + 1] = b[1];
  }

  // ---------------------------------------------------------------- SHA-256

  function rotr32(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  var W256 = new Uint32Array(64);

  function compress256(H, data, off) {
    var W = W256;
    var t;
    for (t = 0; t < 16; t++) {
      var p = off + 4 * t;
      W[t] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    }
    for (t = 16; t < 64; t++) {
      var w15 = W[t - 15];
      var w2 = W[t - 2];
      var s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      var s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      var S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K256[t] + W[t]) >>> 0;
      var S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  // ---------------------------------------------------------------- SHA-512

  var W512 = new Uint32Array(160); // 80 words as [hi, lo]

  // Rotate right a 64-bit value (hi, lo) by n bits, 0 < n < 32; the result goes to R.
  var R = new Uint32Array(2);
  function rotr64(hi, lo, n) {
    if (n >= 32) {
      var t = hi; hi = lo; lo = t;
      n -= 32;
    }
    if (n === 0) {
      R[0] = hi; R[1] = lo;
    } else {
      R[0] = (hi >>> n) | (lo << (32 - n));
      R[1] = (lo >>> n) | (hi << (32 - n));
    }
  }

  function compress512(H, data, off) {
    var W = W512;
    var t;
    for (t = 0; t < 32; t++) {
      var p = off + 4 * t;
      W[t] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    }
    for (t = 16; t < 80; t++) {
      var h15 = W[2 * (t - 15)], l15 = W[2 * (t - 15) + 1];
      rotr64(h15, l15, 1); var s0h = R[0], s0l = R[1];
      rotr64(h15, l15, 8); s0h ^= R[0]; s0l ^= R[1];
      s0h ^= h15 >>> 7; s0l ^= (l15 >>> 7) | (h15 << 25);
      var h2 = W[2 * (t - 2)], l2 = W[2 * (t - 2) + 1];
      rotr64(h2, l2, 19); var s1h = R[0], s1l = R[1];
      rotr64(h2, l2, 61); s1h ^= R[0]; s1l ^= R[1];
      s1h ^= h2 >>> 6; s1l ^= (l2 >>> 6) | (h2 << 26);
      var lo = (W[2 * (t - 16) + 1] >>> 0) + (s0l >>> 0) + (W[2 * (t - 7) + 1] >>> 0) + (s1l >>> 0);
      var hi = (W[2 * (t - 16)] >>> 0) + (s0h >>> 0) + (W[2 * (t - 7)] >>> 0) + (s1h >>> 0) + Math.floor(lo / 4294967296);
      W[2 * t] = hi >>> 0;
      W[2 * t + 1] = lo >>> 0;
    }
    var ah = H[0], al = H[1], bh = H[2], bl = H[3], ch_ = H[4], cl = H[5], dh = H[6], dl = H[7];
    var eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (t = 0; t < 80; t++) {
      rotr64(eh, el, 14); var S1h = R[0], S1l = R[1];
      rotr64(eh, el, 18); S1h ^= R[0]; S1l ^= R[1];
      rotr64(eh, el, 41); S1h ^= R[0]; S1l ^= R[1];
      var chh = (eh & fh) ^ (~eh & gh);
      var chl = (el & fl) ^ (~el & gl);
      var l1 = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K_LO[t] + W[2 * t + 1];
      var h1 = (hh >>> 0) + (S1h >>> 0) + (chh >>> 0) + K_HI[t] + W[2 * t] + Math.floor(l1 / 4294967296);
      var t1h = h1 >>> 0, t1l = l1 >>> 0;
      rotr64(ah, al, 28); var S0h = R[0], S0l = R[1];
      rotr64(ah, al, 34); S0h ^= R[0]; S0l ^= R[1];
      rotr64(ah, al, 39); S0h ^= R[0]; S0l ^= R[1];
      var mh = (ah & bh) ^ (ah & ch_) ^ (bh & ch_);
      var ml = (al & bl) ^ (al & cl) ^ (bl & cl);
      var l2s = (S0l >>> 0) + (ml >>> 0);
      var t2h = ((S0h >>> 0) + (mh >>> 0) + Math.floor(l2s / 4294967296)) >>> 0;
      var t2l = l2s >>> 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      var le = (dl >>> 0) + t1l;
      eh = ((dh >>> 0) + t1h + Math.floor(le / 4294967296)) >>> 0;
      el = le >>> 0;
      dh = ch_; dl = cl; ch_ = bh; cl = bl; bh = ah; bl = al;
      var la = t1l + t2l;
      ah = (t1h + t2h + Math.floor(la / 4294967296)) >>> 0;
      al = la >>> 0;
    }
    var ws = [ah, al, bh, bl, ch_, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (t = 0; t < 16; t += 2) {
      var ls = (H[t + 1] >>> 0) + (ws[t + 1] >>> 0);
      H[t] = ((H[t] >>> 0) + (ws[t] >>> 0) + Math.floor(ls / 4294967296)) >>> 0;
      H[t + 1] = ls >>> 0;
    }
  }

  // ---------------------------------------------------------------- streaming

  function createHasher(alg) {
    var spec = ALGS[alg];
    if (!spec) throw HashError("unknown_algorithm", "Unknown algorithm: " + String(alg));
    var wide = alg !== "sha256";
    var block = wide ? 128 : 64;
    var H = wide ? (alg === "sha384" ? INIT384 : INIT512).slice() : INIT256.slice();
    var compress = wide ? compress512 : compress256;
    var buf = new Uint8Array(block);
    var used = 0;
    var total = 0;
    var done = false;

    function update(data) {
      if (done) throw HashError("finished", "This hasher already produced its digest.");
      if (!(data instanceof Uint8Array)) throw HashError("bad_input", "Hash input must be a Uint8Array.");
      var pos = 0;
      var len = data.length;
      total += len;
      if (used > 0) {
        var take = Math.min(block - used, len);
        buf.set(data.subarray(0, take), used);
        used += take;
        pos = take;
        if (used < block) return;
        compress(H, buf, 0);
        used = 0;
      }
      while (pos + block <= len) {
        compress(H, data, pos);
        pos += block;
      }
      if (pos < len) {
        buf.set(data.subarray(pos), 0);
        used = len - pos;
      }
    }

    function digest() {
      if (done) throw HashError("finished", "This hasher already produced its digest.");
      done = true;
      var lenBytes = wide ? 16 : 8;
      var padTo = block - lenBytes;
      buf[used++] = 0x80;
      if (used > padTo) {
        buf.fill(0, used, block);
        compress(H, buf, 0);
        used = 0;
      }
      buf.fill(0, used, block);
      // Message length in bits, big endian. total is exact below 2^53 bytes.
      var bitsHi = Math.floor(total / 536870912); // total * 8 / 2^32
      var bitsLo = ((total % 536870912) * 8) >>> 0;
      buf[block - 8] = bitsHi >>> 24; buf[block - 7] = (bitsHi >>> 16) & 255;
      buf[block - 6] = (bitsHi >>> 8) & 255; buf[block - 5] = bitsHi & 255;
      buf[block - 4] = bitsLo >>> 24; buf[block - 3] = (bitsLo >>> 16) & 255;
      buf[block - 2] = (bitsLo >>> 8) & 255; buf[block - 1] = bitsLo & 255;
      compress(H, buf, 0);
      var words = alg === "sha256" ? 8 : alg === "sha384" ? 12 : 16;
      var out = new Uint8Array(words * 4);
      for (var k = 0; k < words; k++) {
        out[4 * k] = H[k] >>> 24; out[4 * k + 1] = (H[k] >>> 16) & 255;
        out[4 * k + 2] = (H[k] >>> 8) & 255; out[4 * k + 3] = H[k] & 255;
      }
      return out;
    }

    return { alg: alg, update: update, digest: digest };
  }

  // ---------------------------------------------------------------- helpers

  var HEX = "0123456789abcdef";

  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += HEX[bytes[i] >>> 4] + HEX[bytes[i] & 15];
    return s;
  }

  /** Hash a whole byte array at once. Returns lowercase hex. */
  function hashHex(alg, bytes) {
    var h = createHasher(alg);
    h.update(bytes);
    return toHex(h.digest());
  }

  function algForHexLength(n) {
    for (var id in ALGS) if (ALGS[id].hexLength === n) return id;
    return null;
  }

  // ---------------------------------------------------------------- reading pasted checksums

  var LEGACY = { 32: "MD5", 40: "SHA-1" };
  var TAGS = { sha256: "sha256", "sha-256": "sha256", sha384: "sha384", "sha-384": "sha384", sha512: "sha512", "sha-512": "sha512" };
  var LEGACY_TAGS = { md5: "MD5", sha1: "SHA-1", "sha-1": "SHA-1" };
  var HEX_ONLY = /^[0-9a-fA-F]+$/;

  /**
   * Read the text a person pasted. Returns { entries, unsupported, ignored }.
   * Each entry is { hex (lowercase), alg, name }. `name` is null when the line has none.
   * `unsupported` lists legacy sums (MD5, SHA-1) that were recognised and left out.
   * `ignored` counts lines that were not checksums at all.
   */
  function parseChecksums(text) {
    var entries = [];
    var unsupported = [];
    var ignored = 0;
    var lines = String(text).split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line === "" || line[0] === "#") continue;
      var m, tag, hex, name;

      // BSD: SHA256 (name) = hash
      if ((m = /^([A-Za-z0-9-]+)\s*\((.*)\)\s*=\s*([0-9a-fA-F]+)$/.exec(line))) {
        tag = m[1].toLowerCase(); name = m[2]; hex = m[3];
        if (LEGACY_TAGS[tag]) { unsupported.push(LEGACY_TAGS[tag]); continue; }
        if (TAGS[tag] && ALGS[TAGS[tag]].hexLength === hex.length) {
          entries.push({ hex: hex.toLowerCase(), alg: TAGS[tag], name: name });
        } else ignored++;
        continue;
      }
      // Prefixed: sha256:hash (a name may follow after spaces)
      if ((m = /^([A-Za-z0-9-]+):\s*([0-9a-fA-F]+)(?:\s+\*?(.+))?$/.exec(line))) {
        tag = m[1].toLowerCase(); hex = m[2]; name = m[3] === undefined ? null : m[3];
        if (LEGACY_TAGS[tag]) { unsupported.push(LEGACY_TAGS[tag]); continue; }
        if (TAGS[tag] && ALGS[TAGS[tag]].hexLength === hex.length) {
          entries.push({ hex: hex.toLowerCase(), alg: TAGS[tag], name: name });
        } else ignored++;
        continue;
      }
      // GNU: hash  name   or   hash *name   or a bare hash
      if ((m = /^([0-9a-fA-F]+)(?:[ \t]+\*?(.+))?$/.exec(line)) && (algForHexLength(m[1].length) || LEGACY[m[1].length])) {
        hex = m[1]; name = m[2] === undefined ? null : m[2];
        var alg = algForHexLength(hex.length);
        if (!alg) { unsupported.push(LEGACY[hex.length]); continue; }
        entries.push({ hex: hex.toLowerCase(), alg: alg, name: name });
        continue;
      }
      // Grouped by spaces or colons: "e3b0 c442 ..." or "E3:B0:..."
      var squeezed = line.replace(/[\s:]/g, "");
      if (HEX_ONLY.test(squeezed) && (algForHexLength(squeezed.length) || LEGACY[squeezed.length])) {
        var alg2 = algForHexLength(squeezed.length);
        if (!alg2) { unsupported.push(LEGACY[squeezed.length]); continue; }
        entries.push({ hex: squeezed.toLowerCase(), alg: alg2, name: null });
        continue;
      }
      ignored++;
    }
    return { entries: entries, unsupported: unsupported, ignored: ignored };
  }

  function baseName(n) {
    return String(n).replace(/\\/g, "/").replace(/^\.\//, "").split("/").pop();
  }

  /**
   * Choose the entry that belongs to a file. A name match wins. With no name match, a list of
   * one is used. A longer list is ambiguous and the person must pick the right line.
   * Returns { entry, how } where how is "name", "only", "ambiguous" or "none".
   */
  function pickEntry(entries, fileName) {
    if (entries.length === 0) return { entry: null, how: "none" };
    var want = baseName(fileName);
    var named = entries.filter(function (e) { return e.name !== null && baseName(e.name) === want; });
    if (named.length === 1) return { entry: named[0], how: "name" };
    if (named.length > 1) return { entry: null, how: "ambiguous" };
    if (entries.length === 1) return { entry: entries[0], how: "only" };
    return { entry: null, how: "ambiguous" };
  }

  /** Compare two lowercase hex strings. `different` counts positions that differ. */
  function compareHex(a, b) {
    if (a.length !== b.length) return { equal: false, different: Math.max(a.length, b.length) };
    var diff = 0;
    for (var i = 0; i < a.length; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) diff++;
    return { equal: diff === 0, different: diff };
  }

  var api = Object.freeze({
    ALGS: ALGS,
    HashError: HashError,
    createHasher: createHasher,
    hashHex: hashHex,
    toHex: toHex,
    algForHexLength: algForHexLength,
    parseChecksums: parseChecksums,
    pickEntry: pickEntry,
    compareHex: compareHex,
  });

  globalThis.HashCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
