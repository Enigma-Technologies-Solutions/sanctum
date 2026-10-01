import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src", "shamir-core.js");
// The repo root may set "type": "module", which would load a .js file as ESM and skip
// module.exports. Evaluate the file as a CommonJS style script in this realm instead.
const SRC_TEXT = readFileSync(SRC, "utf8");
const mod = { exports: {} };
new Function("module", SRC_TEXT)(mod);
const core = mod.exports;
const V = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));
const {
  split, combine, parseShare, parseShares, validateShares, toHex, fromHex,
  utf8Encode, utf8Decode, sha256, randomSecret, entropyBits, isValidLabel,
  wipe, ShamirError, LIMITS, LABEL_PATTERN, gf256,
} = core;

const hex = (s) => fromHex(s);

function replay(rngHex) {
  const stream = hex(rngHex);
  let pos = 0;
  const fn = (n) => {
    assert.ok(pos + n <= stream.length, `rng overrun: want ${n} at ${pos} of ${stream.length}`);
    const out = stream.slice(pos, pos + n);
    pos += n;
    return out;
  };
  fn.consumed = () => pos;
  fn.total = stream.length;
  return fn;
}

function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ShamirError, `expected ShamirError, got ${e && e.stack}`);
    assert.equal(e.code, code);
    assert.equal(typeof e.details, "object");
    return e;
  }
  assert.fail(`expected ${code}, nothing thrown`);
}

function subsetOf(shares, idx) {
  return idx.map((i) => shares[i]);
}

function randInt(lo, hi) {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return lo + (b[0] % (hi - lo + 1));
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- primitives

test("sha256 vectors", () => {
  assert.equal(V.sha256.length, 5);
  for (const c of V.sha256) assert.equal(toHex(sha256(hex(c.inputHex))), c.digest);
});

test("sha256 boundary lengths match node:crypto", async () => {
  const { createHash } = await import("node:crypto");
  for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const data = new Uint8Array(len);
    globalThis.crypto.getRandomValues(data);
    assert.equal(toHex(sha256(data)), createHash("sha256").update(data).digest("hex"), `len ${len}`);
  }
});

test("gf256 spot checks and table hash", async () => {
  const { createHash } = await import("node:crypto");
  for (const [a, b, p] of V.gf256.mul) assert.equal(gf256.mul(a, b), p, `${a}*${b}`);
  for (const [a, i] of V.gf256.inv) assert.equal(gf256.inv(a), i, `inv ${a}`);
  const table = new Uint8Array(65536);
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) table[a * 256 + b] = gf256.mul(a, b);
  assert.equal(createHash("sha256").update(table).digest("hex"), V.gf256.mulTableSha256_row_major_a_then_b);
  for (let a = 1; a < 256; a++) assert.equal(gf256.mul(a, gf256.inv(a)), 1);
});

test("generator vector and rules", () => {
  assert.equal(V.generator.alphabet, LIMITS.GENERATOR_ALPHABET);
  assert.equal(V.generator.acceptBelow, 252);
  const c = V.generator.cases[0];
  // The contract requires length >= 8, so pad the stream after the vector bytes.
  const stream = replay(c.bytesHex + "010203" + "0405");
  const out = randomSecret({ length: 8, randomBytes: stream });
  assert.equal(out, c.result + "BCDEF");
  assert.equal(stream.consumed(), stream.total);
});

test("generator output, limits, entropy", () => {
  for (const len of [8, 32, 128]) {
    const s = randomSecret({ length: len });
    assert.equal(s.length, len);
    for (const ch of s) assert.ok(LIMITS.GENERATOR_ALPHABET.includes(ch));
  }
  assert.equal(randomSecret().length, 32);
  throwsCode(() => randomSecret({ length: 7 }), "BAD_OPTION");
  throwsCode(() => randomSecret({ length: 129 }), "BAD_OPTION");
  throwsCode(() => randomSecret({ length: 9.5 }), "BAD_OPTION");
  assert.ok(Math.abs(entropyBits(32) - 32 * Math.log2(28)) < 1e-9);
  assert.equal(entropyBits(32).toFixed(1), "153.8");
  assert.equal(LIMITS.GENERATOR_ALPHABET.length, 28);
  // Rejection sampling: every byte >= 252 is dropped, the rest map by modulo 28.
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const counts = {};
  let pos = 0;
  const src = (n) => {
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = all[pos++ % 256];
    return o;
  };
  for (const ch of randomSecret({ length: 128, randomBytes: src })) counts[ch] = (counts[ch] || 0) + 1;
  assert.ok(Object.keys(counts).length > 20);
});

test("helpers: hex, utf8, label, wipe", () => {
  assert.equal(toHex(Uint8Array.of(0, 15, 16, 255)), "000f10ff");
  assert.deepEqual([...fromHex("00Ff")], [0, 255]);
  assert.equal(fromHex("").length, 0);
  throwsCode(() => fromHex("abc"), "BAD_HEX");
  throwsCode(() => fromHex("zz"), "BAD_HEX");
  throwsCode(() => fromHex("0x"), "BAD_HEX");
  assert.equal(utf8Decode(utf8Encode("héllo 日本 𝄞")), "héllo 日本 𝄞");
  assert.equal(utf8Decode(Uint8Array.of(0xff, 0xfe)), null);
  assert.equal(utf8Decode(Uint8Array.of(0xc3)), null);
  assert.equal(utf8Decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)), "﻿a");
  for (const ok of ["a", "ops", "vault-key", "a.b_c-d", "x".repeat(32), "ss10", "my-ss1x"]) assert.ok(isValidLabel(ok), ok);
  for (const bad of ["", "x".repeat(33), "has space", "a/b", "ss1", "SS1", "a-ss1", "ss1-a", "a-Ss1-b", "é", "a\n"]) {
    assert.ok(!isValidLabel(bad), JSON.stringify(bad));
  }
  assert.ok(LABEL_PATTERN instanceof RegExp);
  const b = Uint8Array.of(1, 2, 3);
  wipe(b);
  assert.deepEqual([...b], [0, 0, 0]);
});

// ---------------------------------------------------------------- vectors

function runVectorSet(name, list) {
  for (const v of list) {
    test(`${name} ${v.id}: replay, parse, subsets`, () => {
      const secret = hex(v.secretHex);
      const snapshot = secret.slice();
      const rng = replay(v.rngHex);
      const r = split(secret, v.n, v.threshold, {
        format: v.format,
        label: v.label,
        padTo: v.padTo,
        randomBytes: rng,
      });
      assert.deepEqual(r.shares.map((s) => s.text), v.shares);
      assert.equal(rng.consumed(), rng.total, "rng stream must be fully consumed");
      assert.equal(r.format, v.format);
      assert.equal(r.threshold, v.threshold);
      assert.equal(r.setId, v.setId);
      assert.deepEqual(secret, snapshot, "split must not mutate the secret");
      r.shares.forEach((s, i) => assert.equal(s.x, i + 1));
      assert.equal(r.shares[0].body.length, r.payloadBytes + 1);
      // Every text parses back to an equal share.
      r.shares.forEach((s, i) => {
        const p = parseShare(v.shares[i]);
        assert.equal(p.text, s.text);
        assert.equal(p.x, s.x);
        assert.equal(p.format, v.format);
        assert.equal(p.label, v.label);
        assert.deepEqual(p.body, s.body);
      });
      for (const sub of v.subsets) {
        const input = subsetOf(v.shares, sub);
        const copy = input.slice();
        const out = combine(input, v.format === "plain" ? {} : undefined);
        assert.equal(toHex(out.secret), v.secretHex);
        assert.deepEqual(input, copy);
        assert.equal(out.format, v.format);
        assert.equal(out.verified, v.format === "ss1");
        assert.equal(out.setId, v.setId);
      }
      if (v.format === "ss1") {
        assert.equal(combine(r.shares.slice(0, v.threshold)).verified, true);
      }
    });
  }
}
runVectorSet("plain", V.plain);
runVectorSet("ss1", V.ss1);

test("plain underThreshold and withThreshold", () => {
  let seen = 0;
  for (const v of V.plain) {
    if (v.underThreshold) {
      const out = combine(subsetOf(v.shares, v.underThreshold.subset));
      assert.equal(toHex(out.secret), v.underThreshold.resultHex);
      assert.notEqual(v.underThreshold.resultHex, v.secretHex);
      seen++;
    }
    if (v.withThreshold) {
      const w = v.withThreshold;
      const out = combine(subsetOf(v.shares, w.subset), { threshold: w.threshold });
      assert.equal(toHex(out.secret), w.resultHex);
      assert.equal(out.threshold, w.threshold);
      assert.equal(out.verified, false);
      assert.equal(out.sharesUsed, w.threshold);
      seen++;
    }
  }
  assert.ok(seen >= 6);
});

test("upstream strings combine and parse", () => {
  assert.equal(V.upstream.length, 4);
  for (const u of V.upstream) {
    for (const sub of u.subsets) {
      const out = combine(subsetOf(u.shares, sub));
      assert.equal(toHex(out.secret), u.secretHex, u.id);
      assert.equal(utf8Decode(out.secret), u.secretUtf8);
      assert.equal(out.format, "plain");
    }
    const p = parseShare(u.shares[0]);
    assert.equal(p.label, u.firstSharesParsed.label);
    assert.equal(p.x, u.firstSharesParsed.x);
  }
});

test("parseValid", () => {
  assert.ok(V.parseValid.length >= 8);
  for (const c of V.parseValid) {
    const s = parseShare(c.input);
    assert.equal(s.format, c.format, c.input);
    assert.equal(s.label, c.label, c.input);
    assert.equal(s.threshold, c.threshold, c.input);
    assert.equal(s.setId, c.setId, c.input);
    assert.equal(s.x, c.x, c.input);
    assert.equal(toHex(s.body), c.bodyHex, c.input);
    assert.equal(s.text, s.text.toLowerCase().replace(s.label ? s.label.toLowerCase() : "\u0000", s.label || ""));
  }
});

test("parseErrors", () => {
  assert.ok(V.parseErrors.length >= 20);
  for (const c of V.parseErrors) {
    throwsCode(() => parseShare(c.input), c.code);
    const toks = parseShares(c.input);
    if (c.input.trim() === "") assert.deepEqual(toks, []);
    else if (!/\s/.test(c.input.trim())) {
      assert.equal(toks.length, 1);
      assert.equal(toks[0].share, null);
      assert.equal(toks[0].error.code, c.code);
      assert.equal(typeof toks[0].error.message, "string");
    }
  }
});

test("combineErrors", () => {
  assert.equal(V.combineErrors.length, 11);
  for (const c of V.combineErrors) {
    const e = throwsCode(() => combine(c.shares, c.options), c.code);
    if (c.details) for (const [k, val] of Object.entries(c.details)) assert.deepEqual(e.details[k], val, `${c.id} ${k}`);
  }
});

test("combineErrors: details for the remaining codes", () => {
  const e11 = V.combineErrors.find((c) => c.id === "e11");
  assert.deepEqual(throwsCode(() => combine(e11.shares, e11.options), "INCONSISTENT_SHARES").details.indices, [3]);
  const e07 = V.combineErrors.find((c) => c.id === "e07");
  assert.equal(throwsCode(() => combine(e07.shares), "DUPLICATE_X").details.x, 1);
  const e06 = V.combineErrors.find((c) => c.id === "e06");
  assert.deepEqual(throwsCode(() => combine(e06.shares), "INTEGRITY_FAILED").details.extraMismatch, []);
});

test("combineSpecial", () => {
  assert.equal(V.combineSpecial.length, 5);
  for (const c of V.combineSpecial) {
    if (c.code) {
      const e = throwsCode(() => combine(c.shares, c.options), c.code);
      if (c.id === "x05") assert.deepEqual(e.details.extraMismatch, [3]);
    } else {
      const out = combine(c.shares, c.options);
      assert.equal(toHex(out.secret), c.secretHex, c.id);
      assert.equal(out.ignoredDuplicates, c.ignoredDuplicates, c.id);
      assert.deepEqual(out.warnings, c.warnings, c.id);
      assert.equal(out.verified, c.verified, c.id);
    }
  }
});

test("parse error index in combine", () => {
  const good = V.ss1[1].shares;
  const e = throwsCode(() => combine([good[0], "ss1-2-zz", good[1]]), "BAD_SYNTAX");
  assert.equal(e.details.index, 1);
  const bad = good[2].slice(0, -1) + (good[2].endsWith("0") ? "1" : "0");
  assert.equal(throwsCode(() => combine([good[0], good[1], bad]), "BAD_CHECKSUM").details.index, 2);
});

// ------------------------------------------------------------ parseShares / validate

test("parseShares tokenising", () => {
  assert.deepEqual(parseShares(""), []);
  assert.deepEqual(parseShares("  \n\t "), []);
  const a = V.plain[1].shares;
  const toks = parseShares(`${a[0]}\n\n  ${a[1]}\tbogus!  ${a[2]}\r\n`);
  assert.equal(toks.length, 4);
  assert.deepEqual(toks.map((t) => t.index), [0, 1, 2, 3]);
  assert.deepEqual(toks.map((t) => t.raw), [a[0], a[1], "bogus!", a[2]]);
  assert.equal(toks[2].share, null);
  assert.equal(toks[2].error.code, "BAD_HEX");
  assert.equal(toks[0].error, null);
  assert.equal(toks[0].share.x, 1);
});

test("validateShares status", () => {
  const ss = V.ss1[1].shares; // 3 of 5
  const empty = validateShares([]);
  assert.equal(empty.format, null);
  assert.equal(empty.needed, null);
  assert.equal(empty.missing, 0);
  assert.equal(empty.canCombine, false);
  assert.equal(empty.count, 0);

  let st = validateShares([ss[0], "junk"]);
  assert.equal(st.format, "ss1");
  assert.equal(st.setId, "0b704569");
  assert.equal(st.threshold, 3);
  assert.equal(st.count, 1);
  assert.equal(st.needed, 3);
  assert.equal(st.missing, 2);
  assert.equal(st.canCombine, false);
  assert.deepEqual(st.problems.map((p) => p.code), ["NOT_ENOUGH_SHARES"]);

  st = validateShares([ss[0], ss[1], ss[0], ss[2]]);
  assert.equal(st.count, 3);
  assert.equal(st.ignoredDuplicates, 1);
  assert.equal(st.missing, 0);
  assert.equal(st.canCombine, true);
  assert.deepEqual(st.problems, []);

  const other = V.combineErrors.find((c) => c.id === "e04").shares[2];
  st = validateShares([ss[0], ss[1], other]);
  assert.equal(st.canCombine, false);
  assert.equal(st.setId, null);
  const ms = st.problems.find((p) => p.code === "MIXED_SETS");
  assert.deepEqual(ms.indices, [2]);

  const plainShare = V.plain[2].shares[2];
  st = validateShares([ss[0], plainShare]);
  assert.equal(st.format, "mixed");
  assert.ok(st.problems.some((p) => p.code === "MIXED_FORMATS"));

  const e07 = V.combineErrors.find((c) => c.id === "e07");
  st = validateShares(e07.shares);
  assert.deepEqual(st.problems.find((p) => p.code === "DUPLICATE_X").indices, [0, 1]);
  assert.equal(st.needed, 2);
  assert.equal(st.format, "plain");
  assert.equal(st.threshold, null);

  const e08 = V.combineErrors.find((c) => c.id === "e08");
  st = validateShares(e08.shares);
  assert.deepEqual(st.problems.find((p) => p.code === "LENGTH_MISMATCH").indices, [1]);

  const p = V.plain[2].shares;
  st = validateShares([p[0], p[1]], { threshold: 3 });
  assert.equal(st.needed, 3);
  assert.equal(st.missing, 1);
  assert.equal(st.canCombine, false);
  st = validateShares([p[0], p[1], p[2]], { threshold: 3 });
  assert.equal(st.canCombine, true);
  st = validateShares([p[0]]);
  assert.equal(st.needed, 2);
  assert.equal(st.missing, 1);

  // Share objects are accepted too.
  st = validateShares(ss.slice(0, 3).map(parseShare));
  assert.equal(st.canCombine, true);
});

// ------------------------------------------------------------ split errors / options

test("split argument errors, in order", () => {
  const s = Uint8Array.of(1, 2, 3);
  throwsCode(() => split(new Uint8Array(0), 1, 1), "SECRET_EMPTY");
  const tl = throwsCode(() => split(new Uint8Array(1025), 3, 2), "SECRET_TOO_LONG");
  assert.deepEqual({ max: tl.details.max, have: tl.details.have }, { max: 1024, have: 1025 });
  for (const n of [1, 256, 2.5, NaN, "3", undefined]) throwsCode(() => split(s, n, 2), "BAD_SHARE_COUNT");
  const bc = throwsCode(() => split(s, 3, 4), "BAD_THRESHOLD");
  assert.deepEqual({ min: bc.details.min, max: bc.details.max, have: bc.details.have }, { min: 2, max: 3, have: 4 });
  for (const k of [1, 0, 2.5, NaN, "2", undefined]) throwsCode(() => split(s, 3, k), "BAD_THRESHOLD");
  throwsCode(() => split(s, 3, 2, { format: "ssss" }), "BAD_OPTION");
  throwsCode(() => split(s, 3, 2, { label: "bad label" }), "BAD_OPTION");
  throwsCode(() => split(s, 3, 2, { label: "ss1" }), "BAD_OPTION");
  throwsCode(() => split(s, 3, 2, { padTo: 8 }), "BAD_OPTION");
  throwsCode(() => split(s, 3, 2, { format: "plain", padTo: 16 }), "BAD_OPTION");
  throwsCode(() => split(s, 3, 2, { randomBytes: "nope" }), "BAD_OPTION");
  throwsCode(() => split(s, 3, 2, { randomBytes: () => new Uint8Array(1) }), "BAD_OPTION");
  // Secret errors win over count errors.
  throwsCode(() => split(new Uint8Array(0), 999, 999, { format: "x" }), "SECRET_EMPTY");
  // Limits are accepted at the edge.
  split(new Uint8Array(1024).fill(7), 2, 2);
  split(s, 2, 2, { padTo: 0 });
  assert.equal(LIMITS.MAX_SECRET_BYTES, 1024);
  assert.equal(LIMITS.MAX_SHARES, 255);
  assert.deepEqual([...LIMITS.PAD_CHOICES], [0, 16, 32, 64, 128, 256]);
});

test("RANDOM_UNAVAILABLE when no CSPRNG and no hook", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    throwsCode(() => split(Uint8Array.of(1), 2, 2), "RANDOM_UNAVAILABLE");
    throwsCode(() => randomSecret(), "RANDOM_UNAVAILABLE");
    // A hook makes it work without the platform source.
    const r = split(Uint8Array.of(1), 2, 2, { format: "plain", randomBytes: (n) => new Uint8Array(n).fill(9) });
    assert.equal(r.shares.length, 2);
  } finally {
    Object.defineProperty(globalThis, "crypto", desc);
  }
  assert.ok(split(Uint8Array.of(1), 2, 2));
});

test("combine option and input errors", () => {
  const p = V.plain[2].shares;
  for (const t of [1, 256, 2.5, "3", 0]) throwsCode(() => combine([p[0], p[1], p[2]], { threshold: t }), "BAD_OPTION");
  throwsCode(() => combine([]), "NO_SHARES");
  throwsCode(() => combine([{ nope: 1 }]), "BAD_SYNTAX");
  // threshold is ignored for ss1
  const s = V.ss1[1].shares;
  assert.equal(combine(s.slice(0, 3), { threshold: 99 }).threshold, 3);
});

test("plain threshold extra check reports input indices", () => {
  const v = V.plain[2];
  const shares = [v.shares[4], v.shares[0], v.shares[1], v.shares[2], v.shares[3]];
  const out = combine(shares, { threshold: 3 });
  assert.equal(toHex(out.secret), v.secretHex);
  assert.equal(out.sharesUsed, 3);
  const tampered = v.shares[3].slice(0, -4) + (v.shares[3].slice(-4, -2) === "00" ? "01" : "00") + v.shares[3].slice(-2);
  const e = throwsCode(() => combine([v.shares[0], v.shares[1], v.shares[2], tampered], { threshold: 3 }), "INCONSISTENT_SHARES");
  assert.deepEqual(e.details.indices, [3]);
});

test("ss1: extra tampered share only warns, by input index", () => {
  const x04 = V.combineSpecial.find((c) => c.id === "x04");
  const out = combine(x04.shares);
  assert.equal(out.verified, true);
  assert.deepEqual(out.warnings, [{ code: "EXTRA_SHARE_MISMATCH", inputIndices: [3] }]);
  assert.equal(out.sharesUsed, 3);
});

// ------------------------------------------------------------ property tests

test("round trip with the real CSPRNG, both formats (400 cases)", () => {
  const pads = [0, 16, 32, 64, 128, 256];
  for (let c = 0; c < 400; c++) {
    const len = randInt(1, 200);
    const secret = new Uint8Array(len);
    globalThis.crypto.getRandomValues(secret);
    const n = randInt(2, 20);
    const k = randInt(2, n);
    const format = c % 2 === 0 ? "ss1" : "plain";
    const opts = { format };
    if (format === "ss1") opts.padTo = pads[randInt(0, pads.length - 1)];
    if (c % 3 === 0) opts.label = "lbl-" + c;
    const snap = secret.slice();
    const r = split(secret, n, k, opts);
    assert.deepEqual(secret, snap);
    assert.equal(r.shares.length, n);
    assert.equal(new Set(r.shares.map((s) => s.x)).size, n);
    const pick = shuffled(r.shares.map((_, i) => i)).slice(0, k);
    const texts = pick.map((i) => r.shares[i].text);
    const out = combine(texts);
    assert.deepEqual(out.secret, secret, `case ${c} ${format} len ${len} n ${n} k ${k}`);
    assert.equal(out.verified, format === "ss1");
    // Share objects work the same as strings.
    assert.deepEqual(combine(pick.map((i) => r.shares[i])).secret, secret);
    // More than k shares still works.
    const more = shuffled(r.shares).slice(0, randInt(k, n));
    assert.deepEqual(combine(more).secret, secret);
    if (format === "ss1") {
      assert.equal(out.threshold, k);
      assert.equal(out.setId, r.setId);
      if (opts.padTo) assert.equal(r.payloadBytes % opts.padTo, 0);
      else assert.equal(r.payloadBytes, len + 6);
    } else {
      assert.equal(r.payloadBytes, len);
    }
  }
});

test("ss1: any k-1 subset fails", () => {
  for (let c = 0; c < 60; c++) {
    const secret = new Uint8Array(randInt(1, 60));
    globalThis.crypto.getRandomValues(secret);
    const n = randInt(3, 12);
    const k = randInt(3, n);
    const r = split(secret, n, k);
    const sub = shuffled(r.shares).slice(0, k - 1);
    const e = throwsCode(() => combine(sub), "NOT_ENOUGH_SHARES");
    assert.equal(e.details.have, k - 1);
    assert.equal(e.details.need, k);
  }
});

test("flipping any single hex digit fails with a typed error (ss1)", () => {
  const secret = utf8Encode("flip test secret");
  for (const [n, k] of [[3, 2], [5, 3]]) {
    const r = split(secret, n, k, { label: "flip" });
    const texts = r.shares.map((s) => s.text);
    for (let target = 0; target < k; target++) {
      const t = texts[target];
      const start = t.indexOf("ss1-");
      for (let pos = start + 4; pos < t.length; pos++) {
        const ch = t[pos];
        if (ch === "-") continue;
        const repl = ch === "0" ? "1" : "0";
        const flipped = t.slice(0, pos) + repl + t.slice(pos + 1);
        const set = texts.slice(0, k).map((x, i) => (i === target ? flipped : x));
        try {
          combine(set);
        } catch (e) {
          assert.ok(e instanceof ShamirError, `untyped error at ${pos}`);
          continue;
        }
        assert.fail(`flip at ${pos} of share ${target} was accepted`);
      }
    }
  }
});

test("flipping a hex digit of a plain share is caught when extras exist", () => {
  const secret = utf8Encode("plain flip");
  const r = split(secret, 5, 3, { format: "plain" });
  const texts = r.shares.map((s) => s.text);
  let caught = 0;
  let parsedOk = 0;
  for (let target = 0; target < 3; target++) {
    const t = texts[target];
    const from = t.indexOf("-") + 1;
    for (let pos = from; pos < t.length; pos++) {
      const repl = t[pos] === "0" ? "1" : "0";
      const flipped = t.slice(0, pos) + repl + t.slice(pos + 1);
      const set = [...texts.slice(0, 3).map((x, i) => (i === target ? flipped : x)), texts[3]];
      try {
        combine(set, { threshold: 3 });
        assert.fail(`flip ${pos} accepted`);
      } catch (e) {
        assert.ok(e instanceof ShamirError);
        caught++;
        if (e.code === "INCONSISTENT_SHARES") parsedOk++;
      }
    }
  }
  assert.ok(caught > 0 && parsedOk > 0);
});

test("no mutation of inputs", () => {
  const secret = utf8Encode("do not touch me");
  const secretSnap = secret.slice();
  const r = split(secret, 5, 3);
  assert.deepEqual(secret, secretSnap);
  const bodies = r.shares.map((s) => s.body.slice());
  const texts = r.shares.map((s) => s.text);
  const arr = r.shares.slice(0, 4);
  const arrSnap = arr.slice();
  const out = combine(arr);
  assert.deepEqual(arr, arrSnap);
  r.shares.forEach((s, i) => {
    assert.deepEqual(s.body, bodies[i]);
    assert.equal(s.text, texts[i]);
  });
  // The result buffer is the caller's: wiping it must not disturb the shares.
  wipe(out.secret);
  const again = combine(arr);
  assert.deepEqual(again.secret, secret);
  const strs = texts.slice(0, 3);
  const strsSnap = strs.slice();
  combine(strs);
  assert.deepEqual(strs, strsSnap);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.shares[0]));
  assert.ok(Object.isFrozen(out));
  assert.throws(() => {
    "use strict";
    r.shares[0].x = 9;
  });
});

// A damaged ss1 share must never turn into a valid plain share. Found in review: a mistyped
// "ss1" tag made the tail of the text parse as a two byte plain share.
test("single character damage to an ss1 share never yields a plain share", () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-._";
  for (const label of [null, "ops", "team-a"]) {
    const { shares } = split(utf8Encode("damage test"), 5, 3, { format: "ss1", label });
    for (const sh of shares) {
      const text = sh.text;
      for (let i = 0; i < text.length; i++) {
        for (const ch of alphabet) {
          if (text[i] === ch) continue;
          const mutated = text.slice(0, i) + ch + text.slice(i + 1);
          let parsed = null;
          try {
            parsed = parseShare(mutated);
          } catch (e) {
            assert.ok(e instanceof ShamirError, "unexpected error type");
          }
          assert.ok(
            !(parsed && parsed.format === "plain"),
            `damaged ss1 parsed as plain: ${mutated} (from ${text})`
          );
        }
      }
    }
  }
});

test("plain prefixes: empty label, bare label, label with number, and nothing else", () => {
  const body = "b254";
  assert.equal(parseShare("-01-" + body).format, "plain");
  assert.equal(parseShare("0a-" + body).label, "0a");
  assert.equal(parseShare("team-a-07-" + body).label, "team-a");
  assert.equal(parseShare(body).format, "plain");
  for (const bad of ["a-b-" + body, "x y-" + body, "a/b-" + body, "-".repeat(3) + body]) {
    assert.throws(() => parseShare(bad), (e) => e instanceof ShamirError && e.code === "BAD_SYNTAX", bad);
  }
});

test("replay draws a documented call sequence", () => {
  const calls = [];
  const hook = (n) => {
    calls.push(n);
    return new Uint8Array(n).fill(3);
  };
  split(utf8Encode("abc"), 4, 3, { padTo: 16, randomBytes: hook });
  assert.deepEqual(calls, [4, 16 * 2]);
  calls.length = 0;
  split(utf8Encode("abc"), 4, 3, { format: "plain", randomBytes: hook });
  assert.deepEqual(calls, [3 * 2]);
});

// ------------------------------------------------------------ hygiene

test("source hygiene: no forbidden strings, no Math.random", () => {
  const src = SRC_TEXT;
  const forbidden = [
    "getUserMedia", "navigator.usb", "navigator.serial", "navigator.hid", "navigator.bluetooth",
    "navigator.geolocation", "Notification", "localStorage", "sessionStorage", "indexedDB",
    "caches.open", "fetch(", "XMLHttpRequest", "new WebSocket", "new EventSource",
    "sanctum.smartcard", "https://", "http://", "</script", "Math.random", "eval(", "new Function",
    "import(", "require(",
  ];
  for (const f of forbidden) assert.ok(!src.includes(f), `source contains ${f}`);
  assert.ok(!/[–—]/.test(src), "no em or en dashes");
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), "no emoji");
});

test("global export and frozen API", () => {
  assert.equal(typeof globalThis.ShamirCore.split, "function");
  assert.deepEqual(Object.keys(globalThis.ShamirCore).sort(), Object.keys(core).sort());
  assert.ok(Object.isFrozen(core));
  for (const name of [
    "LIMITS", "LABEL_PATTERN", "ShamirError", "split", "parseShare", "parseShares", "validateShares",
    "combine", "toHex", "fromHex", "utf8Encode", "utf8Decode", "sha256", "randomSecret",
    "entropyBits", "isValidLabel", "wipe",
  ]) {
    assert.ok(name in core, name);
  }
  const e = new ShamirError("NO_SHARES");
  assert.ok(e instanceof Error);
  assert.equal(e.code, "NO_SHARES");
  assert.deepEqual(e.details, {});
  assert.equal(typeof e.message, "string");
});

test("runs without module (inline use)", async () => {
  const { runInNewContext } = await import("node:vm");
  const ctx = { TextEncoder, TextDecoder, crypto: globalThis.crypto };
  ctx.globalThis = ctx;
  runInNewContext(SRC_TEXT, ctx);
  assert.equal(typeof ctx.ShamirCore.split, "function");
  const r = ctx.ShamirCore.split(Uint8Array.of(1, 2, 3), 3, 2);
  assert.equal(r.shares.length, 3);
  assert.equal(ctx.ShamirCore.combine(r.shares.slice(1)).secret.length, 3);
});

test("timing: 1024 bytes, n=255, k=255", () => {
  const secret = new Uint8Array(1024);
  globalThis.crypto.getRandomValues(secret);
  for (const format of ["plain", "ss1"]) {
    const t0 = performance.now();
    const r = split(secret, 255, 255, { format });
    const t1 = performance.now();
    const out = combine(r.shares);
    const t2 = performance.now();
    assert.deepEqual(out.secret, secret);
    const splitMs = t1 - t0;
    const combineMs = t2 - t1;
    console.log(`# ${format}: split ${splitMs.toFixed(0)} ms, combine ${combineMs.toFixed(0)} ms`);
    assert.ok(splitMs < 2000, `split took ${splitMs} ms`);
    assert.ok(combineMs < 2000, `combine took ${combineMs} ms`);
  }
});
