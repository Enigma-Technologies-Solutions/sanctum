// Differential tests for the Shamir example tool.
//
// Part 1 checks the independent reference (reference-core.mjs) against every
// section of vectors.json. Part 2 runs the production core (../src/shamir-core.js)
// against the same vectors and then against the reference with seeded fuzzing.
// Part 2 is skipped with a message when the production file does not exist.
// A .js core is run as a classic script (it sets globalThis.ShamirCore).
//
// Environment:
//   SHAMIR_CORE_PATH   override the production core path (used to prove the
//                      harness catches a mutated core)
//   DIFF_CASES         number of fuzz seeds (default 2500)
//   DIFF_SEED          run one seed only, for replaying a reported mismatch

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import * as ref from "./reference-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(here, "vectors.json"), "utf8"));
const PROD_PATH = process.env.SHAMIR_CORE_PATH || path.join(here, "..", "src", "shamir-core.js");
const HAVE_PROD = fs.existsSync(PROD_PATH);
const require = createRequire(import.meta.url);

const hex = ref.toHex;
const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

// ------------------------------------------------------------ helpers

function replay(rngHex) {
  const buf = Buffer.from(rngHex, "hex");
  let pos = 0;
  return {
    hook(n) {
      assert.ok(Number.isInteger(n) && n >= 0, `randomBytes called with ${n}`);
      assert.ok(pos + n <= buf.length, `randomBytes(${n}) overruns the stream (${pos} of ${buf.length} used)`);
      const out = Uint8Array.from(buf.subarray(pos, pos + n));
      pos += n;
      return out;
    },
    used: () => pos,
    total: buf.length,
  };
}

// Deterministic generators. Case decisions and byte streams are separate.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const f = mulberry32(seed);
  return {
    f,
    int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
    chance: (p) => f() < p,
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(f() * 256);
      return out;
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(f() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}
function makeStream(seed) {
  let s = (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
  const calls = [];
  const hook = (n) => {
    calls.push(n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s >>> 24;
    }
    return out;
  };
  hook.calls = calls;
  return hook;
}

function outcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, code: e && e.code ? e.code : `NOCODE:${e && e.name}:${e && e.message}` };
  }
}

function short(v) {
  return JSON.parse(
    JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 240 ? `${x.slice(0, 120)}...(${x.length} chars)...${x.slice(-40)}` : x)),
  );
}

// ------------------------------------------------------------ adapters

// Both implementations go through the same shape so the vector runner and
// the fuzzer never special-case either one.
function adaptRef() {
  return ref;
}
function adaptProd(core) {
  return {
    split: (secret, n, k, o) => {
      const r = core.split(secret, n, k, o);
      return {
        shares: r.shares.map((s) => ({ text: s.text })),
        format: r.format,
        threshold: r.threshold,
        setId: r.setId,
        payloadBytes: r.payloadBytes,
      };
    },
    combine: (texts, o) => core.combine(texts, o),
    parseShare: (t) => core.parseShare(t),
    randomSecret: (o) => core.randomSecret(o),
    sha256: (b) => core.sha256(b),
    toHex: (b) => hex(b),
  };
}

function normCombine(r) {
  return {
    secretHex: hex(r.secret),
    verified: r.verified,
    setId: r.setId,
    threshold: r.threshold,
    format: r.format,
    sharesUsed: r.sharesUsed,
    ignoredDuplicates: r.ignoredDuplicates,
    warnings: (r.warnings || []).map((w) => ({ code: w.code, inputIndices: Array.from(w.inputIndices) })),
  };
}
function normParse(s) {
  return {
    format: s.format,
    label: s.label,
    x: s.x,
    threshold: s.threshold,
    setId: s.setId,
    bodyHex: hex(s.body),
    text: s.text,
  };
}
function normSplit(r) {
  return {
    texts: r.shares.map((s) => s.text),
    format: r.format,
    threshold: r.threshold,
    setId: r.setId,
    payloadBytes: r.payloadBytes,
  };
}

// ------------------------------------------------------------ vector runner

function runVectors(impl, name, opts) {
  const strictGenerator = opts.strictGenerator;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    assert.ok(cond, `[${name}] ${msg}`);
  };
  const eq = (a, b, msg) => {
    checks++;
    assert.deepEqual(a, b, `[${name}] ${msg}`);
  };
  const throwsCode = (fn, code, msg) => {
    checks++;
    let err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err, `[${name}] ${msg}: expected ${code}, nothing thrown`);
    assert.equal(err.code, code, `[${name}] ${msg}: expected ${code}, got ${err.code} (${err.message})`);
    return err;
  };

  for (const v of V.sha256) eq(hex(impl.sha256(unhex(v.inputHex))), v.digest, `sha256 of ${v.inputHex.slice(0, 16)}`);

  // generator. The public API wants length >= 8, so the 3 symbol vector is
  // extended with five zero bytes (each one is symbol A): 9A9 then AAAAA.
  for (const c of V.generator.cases) {
    eq(ref.generatorModel(Buffer.from(c.bytesHex, "hex")), c.result, "generator rule on the vector bytes");
    const stream = Buffer.concat([Buffer.from(c.bytesHex, "hex"), Buffer.alloc(5)]);
    let pos = 0;
    const hook = (n) => {
      if (strictGenerator) ok(pos + n <= stream.length, `generator asked for ${n} bytes with ${stream.length - pos} left`);
      const out = new Uint8Array(n).fill(0xff); // 0xff is always rejected
      const take = Math.min(n, stream.length - pos);
      out.set(stream.subarray(pos, pos + take));
      pos += take;
      return out;
    };
    eq(impl.randomSecret({ length: 8, randomBytes: hook }), c.result + "AAAAA", "generator API replay");
    if (strictGenerator) eq(pos, stream.length, "generator consumed the stream exactly");
  }

  // plain and ss1 split replay + combine
  for (const sect of ["plain", "ss1"]) {
    for (const v of V[sect]) {
      const secret = unhex(v.secretHex);
      const before = hex(secret);
      const r = replay(v.rngHex);
      const opt = { format: v.format, label: v.label, padTo: v.padTo, randomBytes: r.hook };
      const res = impl.split(secret, v.n, v.threshold, opt);
      eq(res.shares.map((s) => s.text), v.shares, `${v.id} replay texts`);
      eq(r.used(), r.total, `${v.id} rng stream fully consumed`);
      eq(hex(secret), before, `${v.id} split left the secret untouched`);
      if (v.setId !== null) eq(res.setId, v.setId, `${v.id} set id`);
      for (const sub of v.subsets) {
        const out = impl.combine(sub.map((i) => v.shares[i]));
        eq(hex(out.secret), v.secretHex, `${v.id} combine subset ${sub.join(",")}`);
        eq(out.verified, v.format === "ss1", `${v.id} verified flag`);
      }
      if (v.underThreshold) {
        const out = impl.combine(v.underThreshold.subset.map((i) => v.shares[i]));
        eq(hex(out.secret), v.underThreshold.resultHex, `${v.id} underThreshold wrong value`);
        ok(out.verified === false, `${v.id} underThreshold not verified`);
      }
      if (v.withThreshold) {
        const out = impl.combine(v.withThreshold.subset.map((i) => v.shares[i]), { threshold: v.withThreshold.threshold });
        eq(hex(out.secret), v.withThreshold.resultHex, `${v.id} withThreshold`);
      }
    }
  }

  for (const p of V.parseValid) {
    const s = impl.parseShare(p.input);
    eq(
      { format: s.format, label: s.label, threshold: s.threshold, setId: s.setId, x: s.x, bodyHex: hex(s.body) },
      { format: p.format, label: p.label, threshold: p.threshold, setId: p.setId, x: p.x, bodyHex: p.bodyHex },
      `parseValid ${p.input.slice(0, 30)}`,
    );
  }
  for (const p of V.parseErrors) throwsCode(() => impl.parseShare(p.input), p.code, `parseErrors ${p.why}`);

  for (const c of V.combineErrors) {
    const err = throwsCode(() => impl.combine(c.shares, c.options), c.code, `combineErrors ${c.id} (${c.why})`);
    if (c.details) for (const key of Object.keys(c.details)) eq(err.details[key], c.details[key], `${c.id} details.${key}`);
  }

  for (const c of V.combineSpecial) {
    if (c.code) {
      const err = throwsCode(() => impl.combine(c.shares, c.options), c.code, `combineSpecial ${c.id}`);
      void err;
    } else {
      const out = impl.combine(c.shares, c.options);
      eq(hex(out.secret), c.secretHex, `${c.id} secret`);
      eq(out.ignoredDuplicates, c.ignoredDuplicates, `${c.id} ignoredDuplicates`);
      eq(out.verified, c.verified, `${c.id} verified`);
      eq(normCombine(out).warnings, c.warnings, `${c.id} warnings`);
    }
  }

  for (const u of V.upstream) {
    const secret = u.secretHex;
    for (const sub of u.subsets) {
      const out = impl.combine(sub.map((i) => u.shares[i]));
      eq(hex(out.secret), secret, `upstream ${u.id} subset ${sub.join(",")}`);
      ok(out.format === "plain" && out.verified === false, `upstream ${u.id} is plain`);
    }
    const out = impl.combine(u.shares, { threshold: u.threshold });
    eq(hex(out.secret), secret, `upstream ${u.id} all shares with threshold ${u.threshold}`);
    eq(out.warnings.length, 0, `upstream ${u.id} no warnings`);
    const first = impl.parseShare(u.shares[0]);
    eq({ label: first.label, x: first.x }, u.firstSharesParsed, `upstream ${u.id} first share parse`);
  }

  return checks;
}

// ------------------------------------------------------------ part 1

test("reference: gf256 table matches the vectors", (t) => {
  let checks = 0;
  for (const [a, b, c] of V.gf256.mul) {
    assert.equal(ref.gfMul(a, b), c, `mul(${a},${b})`);
    checks++;
  }
  for (const [a, b] of V.gf256.inv) {
    assert.equal(ref.gfInv(a), b, `inv(${a})`);
    checks++;
  }
  const table = Buffer.alloc(65536);
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) table[a * 256 + b] = ref.gfMul(a, b);
  const digest = Buffer.from(ref.sha256(table)).toString("hex");
  assert.equal(digest, V.gf256.mulTableSha256_row_major_a_then_b);
  checks++;
  t.diagnostic(`gf256 checks: ${checks} (spot checks plus full 65536 entry table hash)`);
});

let refVectorChecks = 0;
test("reference: every vectors.json section", (t) => {
  refVectorChecks = runVectors(adaptRef(), "reference", { strictGenerator: true });
  t.diagnostic(`reference vector checks passed: ${refVectorChecks}`);
  assert.ok(refVectorChecks > 150);
});

test("reference: generator vector, bytes fb fc ff 00 1b", () => {
  assert.equal(ref.generatorModel(unhex("fbfcff001b")), "9A9");
});

test("reference: split refuses bad input with SPEC 6 codes", () => {
  const s = Uint8Array.of(1, 2, 3);
  const code = (fn) => outcome(fn).code;
  assert.equal(code(() => ref.split(new Uint8Array(0), 3, 2)), "SECRET_EMPTY");
  assert.equal(code(() => ref.split(new Uint8Array(1025), 3, 2)), "SECRET_TOO_LONG");
  assert.equal(code(() => ref.split(s, 1, 2)), "BAD_SHARE_COUNT");
  assert.equal(code(() => ref.split(s, 256, 2)), "BAD_SHARE_COUNT");
  assert.equal(code(() => ref.split(s, 2.5, 2)), "BAD_SHARE_COUNT");
  assert.equal(code(() => ref.split(s, 3, 1)), "BAD_THRESHOLD");
  assert.equal(code(() => ref.split(s, 3, 4)), "BAD_THRESHOLD");
  assert.equal(code(() => ref.split(s, 3, 2, { label: "a b" })), "BAD_OPTION");
  assert.equal(code(() => ref.split(s, 3, 2, { label: "x-SS1-y" })), "BAD_OPTION");
  assert.equal(code(() => ref.split(s, 3, 2, { padTo: 48 })), "BAD_OPTION");
  assert.equal(code(() => ref.split(s, 3, 2, { format: "plain", padTo: 16 })), "BAD_OPTION");
  assert.equal(code(() => ref.split(s, 3, 2, { format: "nope" })), "BAD_OPTION");
  assert.equal(code(() => ref.split(s, 3, 2, { randomBytes: 5 })), "BAD_OPTION");
});

// ------------------------------------------------------------ part 2

let prodCache = null;
function loadProd() {
  if (prodCache) return prodCache;
  let core;
  if (PROD_PATH.endsWith(".js")) {
    // The repo root is "type": "module", so require() would treat a .js file as
    // ESM and module.exports would stay unset. The core is a classic script
    // that sets globalThis.ShamirCore, so run it as one.
    delete globalThis.ShamirCore;
    vm.runInThisContext(fs.readFileSync(PROD_PATH, "utf8"), { filename: PROD_PATH });
    core = globalThis.ShamirCore;
  } else {
    core = require(PROD_PATH); // .cjs shims used to prove the harness catches bugs
  }
  assert.ok(core && typeof core.split === "function", `${PROD_PATH} did not define ShamirCore.split`);
  prodCache = core;
  return core;
}

const SKIP_MSG = `production core not found at ${PROD_PATH}: skipping the differential tests (reference-only run)`;
if (!HAVE_PROD) console.log(`# NOTE ${SKIP_MSG}`);
const prodTest = (name, fn) => test(name, { skip: HAVE_PROD ? false : SKIP_MSG }, fn);

prodTest("production: every vectors.json section", (t) => {
  const prod = adaptProd(loadProd());
  const checks = runVectors(prod, "production", { strictGenerator: false });
  t.diagnostic(`production vector checks passed: ${checks}`);
});

// ---- fuzz machinery

const LABELS = [null, null, "ops", "a", "my-team.2026", "x_y.z-9", "A".repeat(32), "vault-key", "ss10", "s-s1x", "Ss2-ss1x"];
const PADS = [0, 16, 32, 64, 128, 256];
const GARBAGE = ["", "   ", "hello", "01-", "ss1", "-", "--", "ss1-", "00-00", "01-ab", "01-zz", "ss1-3-0b704569-00-0000", "0a-b254", "-01-b254", "\t01-b254\n"];

function makeSecret(r, L) {
  if (r.chance(0.12)) {
    const pool = ["é", "日本語", "😀", "Ω", "a", "z9", " ", "\u0000", "ñ"];
    let s = "";
    while (new TextEncoder().encode(s).length < L) s += r.pick(pool);
    return ref.utf8(s);
  }
  return r.bytes(L);
}

function flipChar(r, text) {
  const pos = r.int(0, text.length - 1);
  const repl = r.pick("0123456789abcdefABCDEF-xzG é".split(""));
  const out = text.slice(0, pos) + (repl === text[pos] ? "q" : repl) + text.slice(pos + 1);
  return out;
}

function forgeBody(r, text, mode) {
  // Change bytes of a valid ss1 share body and recompute the checksum, so only
  // deeper checks (tag, consistency) can notice.
  const s = ref.parseShare(text);
  if (s.format !== "ss1") {
    const body = Uint8Array.from(s.body);
    body[r.int(0, body.length - 2)] ^= r.int(1, 255);
    return `${s.label ? s.label + "-" : ""}${String(s.x).padStart(2, "0")}-${hex(body)}`;
  }
  let body = Uint8Array.from(s.body);
  if (mode === "truncate" && body.length > 9) {
    body = Uint8Array.from([...body.subarray(0, body.length - 2), body[body.length - 1]]);
  } else {
    body[r.int(0, body.length - 2)] ^= r.int(1, 255);
  }
  return ref.buildSs1Text(s.label, s.threshold, s.setId, body);
}

function subsetOf(r, texts, k) {
  const n = texts.length;
  const sizes = [Math.max(1, k - 1), k, Math.min(n, k + 1), n, r.int(1, n)];
  const size = Math.min(n, r.pick(sizes));
  return r.shuffle(texts.map((_, i) => i)).slice(0, size).map((i) => texts[i]);
}

function scenarios(r, c, texts, other) {
  // c: {format,k,n,secretHex}; texts: valid shares of this split; other: texts of second splits
  const list = [];
  const add = (name, inputs, options) => list.push({ name, inputs, options });
  const k = c.k;
  const plainOpt = () => (c.format === "plain" && r.chance(0.6) ? { threshold: r.pick([k, k, k - 1 < 2 ? 2 : k - 1, k + 1 > 255 ? 255 : k + 1, r.int(2, 255)]) } : undefined);

  const kind = r.int(0, 11);
  const sub = subsetOf(r, texts, k);
  switch (kind) {
    case 0:
      add("subset", sub, plainOpt());
      break;
    case 1: {
      const arr = sub.slice();
      for (let i = r.int(1, 3); i > 0; i--) arr.splice(r.int(0, arr.length), 0, r.pick(sub));
      add("subset_with_duplicates", arr, plainOpt());
      break;
    }
    case 2: {
      const arr = sub.slice();
      const at = r.int(0, arr.length - 1);
      arr[at] = flipChar(r, arr[at]);
      add("bitflip", arr, plainOpt());
      break;
    }
    case 3: {
      add("mixed_sets", r.shuffle([...sub, ...subsetOf(r, other.same, k)]), plainOpt());
      break;
    }
    case 4:
      add("mixed_formats", r.shuffle([...sub, ...subsetOf(r, other.otherFormat, k)]), plainOpt());
      break;
    case 5: {
      const arr = sub.slice();
      const at = r.int(0, arr.length - 1);
      arr[at] = forgeBody(r, arr[at], "flip");
      add("forged_body", arr, plainOpt());
      break;
    }
    case 6: {
      // valid first k, then extras, one extra forged
      const order = r.shuffle(texts);
      const arr = order.slice(0, Math.min(texts.length, k + r.int(1, 3)));
      if (arr.length > k) {
        const at = r.int(k, arr.length - 1);
        arr[at] = forgeBody(r, arr[at], "flip");
      }
      add("forged_extra", arr, plainOpt());
      break;
    }
    case 7: {
      const arr = sub.map((x) => (r.chance(0.5) ? `  ${x}\n` : x.toUpperCase().replace(/^([^-]*)/, (m) => m)));
      add("whitespace_and_case", arr, plainOpt());
      break;
    }
    case 8: {
      const arr = sub.slice();
      arr[r.int(0, arr.length - 1)] = r.pick(GARBAGE);
      add("garbage_token", arr, plainOpt());
      break;
    }
    case 9: {
      const arr = sub.slice();
      const at = r.int(0, arr.length - 1);
      arr[at] = forgeBody(r, arr[at], "truncate");
      add("forged_truncated", arr, plainOpt());
      break;
    }
    case 10:
      add("mixed_lengths", r.shuffle([...sub, ...subsetOf(r, other.otherLength, k)]), plainOpt());
      break;
    default:
      add("all_shares_reversed", texts.slice().reverse(), plainOpt());
  }
  return list;
}

function compareAll(mm, ctx, a, b, extra) {
  const aj = JSON.stringify(a);
  const bj = JSON.stringify(b);
  if (aj !== bj) mm.push({ ...ctx, ...extra, reference: short(a), production: short(b) });
}

function splitBoth(refImpl, prodImpl, mm, ctx, secret, n, k, opts, streamSeed) {
  const copyBefore = Uint8Array.from(secret);
  const hA = makeStream(streamSeed);
  const hB = makeStream(streamSeed);
  const A = outcome(() => normSplit(refImpl.split(secret, n, k, { ...opts, randomBytes: hA })));
  const B = outcome(() => normSplit(prodImpl.split(secret, n, k, { ...opts, randomBytes: hB })));
  const view = (o) => (o.ok ? { ok: true, ...o.value, texts: o.value.texts.map((x) => x) } : { ok: false, code: o.code });
  compareAll(mm, { ...ctx, step: "split", params: { secretLen: secret.length, n, k, opts: { ...opts, randomBytes: undefined } } }, view(A), view(B), {
    rngCalls: { reference: hA.calls, production: hB.calls },
  });
  if (hex(secret) !== hex(copyBefore)) mm.push({ ...ctx, step: "split mutated its secret input" });
  if (A.ok && B.ok && JSON.stringify(hA.calls) !== JSON.stringify(hB.calls)) {
    mm.push({ ...ctx, step: "randomBytes call sequence", reference: hA.calls, production: hB.calls });
  }
  return A;
}

function combineBoth(refImpl, prodImpl, mm, ctx, inputs, options) {
  const A = outcome(() => normCombine(refImpl.combine(inputs, options)));
  const B = outcome(() => normCombine(prodImpl.combine(inputs, options)));
  const view = (o) => (o.ok ? { ok: true, ...o.value } : { ok: false, code: o.code });
  compareAll(mm, { ...ctx, step: "combine", options }, view(A), view(B), { inputs });
  // parse every token too
  for (const tok of inputs) {
    const pa = outcome(() => normParse(refImpl.parseShare(tok)));
    const pb = outcome(() => normParse(prodImpl.parseShare(tok)));
    compareAll(mm, { ...ctx, step: "parseShare" }, pa.ok ? pa.value : { code: pa.code }, pb.ok ? pb.value : { code: pb.code }, { token: tok });
  }
  return A;
}

function runSeed(refImpl, prodImpl, mm, seed, forced) {
  const r = makeRng(seed);
  const format = forced?.format ?? r.pick(["ss1", "ss1", "plain"]);
  const big = r.chance(0.02);
  const L = forced?.L ?? (big ? r.int(65, 500) : r.int(1, 64));
  const nBand = r.f();
  const n = forced?.n ?? (nBand < 0.7 ? r.int(2, 12) : nBand < 0.93 ? r.int(2, 40) : r.int(2, 255));
  const kBand = r.f();
  const k = forced?.k ?? (kBand < 0.2 ? 2 : kBand < 0.3 ? n : r.int(2, n));
  const padTo = forced?.padTo ?? (format === "ss1" ? r.pick(PADS) : 0);
  const label = forced && "label" in forced ? forced.label : r.pick(LABELS);
  const secret = forced?.secret ?? makeSecret(r, L);
  const ctx = { seed, format };

  // sometimes feed one invalid argument
  let args = { secret, n, k, opts: { format, label, padTo } };
  const bad = forced ? null : r.chance(0.06) ? r.int(0, 9) : null;
  if (bad !== null) {
    const a = { secret, n, k, opts: { ...args.opts } };
    if (bad === 0) a.secret = new Uint8Array(0);
    else if (bad === 1) a.secret = new Uint8Array(1025);
    else if (bad === 2) a.n = r.pick([1, 0, 256, 300, 2.5, -1]);
    else if (bad === 3) a.k = r.pick([1, 0, n + 1, 256, 2.5]);
    else if (bad === 4) a.opts.label = r.pick(["", "has space", "x".repeat(33), "ss1", "a-SS1-b", "é"]);
    else if (bad === 5) a.opts.padTo = r.pick([1, 15, 48, 512, -16, "32"]);
    else if (bad === 6) a.opts = { ...a.opts, format: "plain", padTo: 16 };
    else if (bad === 7) a.opts.format = r.pick(["SS1", "other", ""]);
    else if (bad === 8) a.opts.randomBytes = "nope";
    else a.opts.padTo = 7;
    args = a;
    ctx.invalidCase = bad;
  }

  const opts = args.opts;
  if (opts.randomBytes !== undefined) {
    // bad randomBytes option: pass through untouched, compare codes only
    const A = outcome(() => refImpl.split(args.secret, args.n, args.k, opts));
    const B = outcome(() => prodImpl.split(args.secret, args.n, args.k, opts));
    compareAll(mm, { ...ctx, step: "split bad randomBytes" }, { ok: A.ok, code: A.code }, { ok: B.ok, code: B.code }, {});
    return;
  }

  const A = splitBoth(refImpl, prodImpl, mm, ctx, args.secret, args.n, args.k, opts, seed);
  if (!A.ok) return;

  // second splits for mixing
  const mk = (over, s2) => {
    const o = splitBoth(refImpl, prodImpl, mm, { ...ctx, second: true }, over.secret ?? secret, args.n, args.k, { ...opts, ...(over.opts || {}) }, s2);
    return o.ok ? o.value.texts : [];
  };
  const otherFormat = mk({ opts: { format: format === "ss1" ? "plain" : "ss1", padTo: 0 } }, seed + 7001);
  const same = mk({}, seed + 7002);
  const otherLength = mk({ secret: makeSecret(r, Math.max(1, (args.secret.length % 40) + 1 + (args.secret.length <= 40 ? 1 : 0))) }, seed + 7003);
  const texts = A.value.texts;
  const c = { format, k: args.k, n: args.n, secretHex: hex(args.secret) };

  // a plain minimal "everything right" case so the success path is always exercised
  const good = r.shuffle(texts).slice(0, args.k);
  combineBoth(refImpl, prodImpl, mm, { ...ctx, scenario: "exact_k" }, good, format === "plain" && r.chance(0.5) ? { threshold: args.k } : undefined);

  const count = forced ? 3 : 4;
  for (let i = 0; i < count; i++) {
    for (const sc of scenarios(r, c, texts, { same, otherFormat, otherLength })) {
      combineBoth(refImpl, prodImpl, mm, { ...ctx, scenario: sc.name }, sc.inputs, sc.options);
    }
  }
}

function reportMismatches(mm, what) {
  if (mm.length === 0) return;
  const lines = mm.slice(0, 3).map((m, i) => `--- mismatch ${i + 1} of ${mm.length}\n${JSON.stringify(short(m), null, 1)}`);
  lines.push(`Replay one seed with: DIFF_SEED=<seed> node --test examples/shamir/test/differential.test.mjs`);
  assert.fail(`${what}: ${mm.length} mismatches between reference and production\n${lines.join("\n")}`);
}

prodTest("differential: seeded fuzz, split texts and combine outcomes", (t) => {
  const prod = adaptProd(loadProd());
  const only = process.env.DIFF_SEED !== undefined ? Number(process.env.DIFF_SEED) : null;
  const total = only !== null ? 1 : Number(process.env.DIFF_CASES || 2500);
  assert.ok(only !== null || total >= 2000, "DIFF_CASES below 2000 is only allowed together with DIFF_SEED");
  const mm = [];
  let ran = 0;
  for (let i = 0; i < total; i++) {
    runSeed(ref, prod, mm, only !== null ? only : i, null);
    ran++;
    if (mm.length >= 20) break;
  }
  t.diagnostic(`fuzz seeds run: ${ran} of ${total}, mismatches: ${mm.length}`);
  reportMismatches(mm, "fuzz");
});

prodTest("differential: edge sizes, paddings, labels, utf-8", (t) => {
  const prod = adaptProd(loadProd());
  const mm = [];
  let cases = 0;
  const run = (seed, forced) => {
    cases++;
    runSeed(ref, prod, mm, seed, forced);
  };
  const r = makeRng(99);
  run(5001, { format: "ss1", L: 1, n: 2, k: 2, padTo: 0, label: null, secret: Uint8Array.of(0x61) });
  run(5002, { format: "plain", L: 1, n: 2, k: 2, padTo: 0, label: null, secret: Uint8Array.of(0) });
  run(5003, { format: "ss1", L: 1024, n: 5, k: 3, padTo: 0, label: "big", secret: r.bytes(1024) });
  run(5004, { format: "plain", L: 1024, n: 7, k: 4, padTo: 0, label: null, secret: r.bytes(1024) });
  run(5005, { format: "ss1", L: 1, n: 255, k: 255, padTo: 0, label: null, secret: Uint8Array.of(7) });
  run(5006, { format: "plain", L: 1, n: 255, k: 255, padTo: 0, label: null, secret: Uint8Array.of(255) });
  run(5007, { format: "ss1", L: 16, n: 255, k: 2, padTo: 0, label: null, secret: r.bytes(16) });
  // every padTo at the boundaries around a multiple
  for (const p of PADS) {
    const edges = p === 0 ? [1, 10, 100] : [p - 6 - 1, p - 6, p - 6 + 1, p * 2 - 6, p * 2 - 5, 1];
    for (const L of edges) {
      if (L < 1) continue;
      run(6000 + p * 7 + L, { format: "ss1", L, n: 4, k: 3, padTo: p, label: null, secret: r.bytes(L) });
    }
  }
  // labels at the limits, and hyphens
  for (const label of ["a", "Z", "A".repeat(32), "a.b_c-d", "x-".repeat(15) + "xy", "0", "99", "9-9", "ss2", "my-ss10-team"]) {
    run(7000 + label.length, { format: "ss1", L: 12, n: 5, k: 3, padTo: 16, label, secret: r.bytes(12) });
    run(7100 + label.length, { format: "plain", L: 12, n: 5, k: 3, padTo: 0, label, secret: r.bytes(12) });
  }
  // labels that must be refused
  for (const label of ["A".repeat(33), "ss1", "SS1", "a-ss1", "ss1-b", "a-Ss1-b", "x y", "a/b", "é", ""]) {
    run(7200 + label.length, { format: "ss1", L: 5, n: 3, k: 2, padTo: 0, label, secret: r.bytes(5) });
    run(7300 + label.length, { format: "plain", L: 5, n: 3, k: 2, padTo: 0, label, secret: r.bytes(5) });
  }
  // utf-8 multi-byte secrets
  for (const text of ["é", "日本語のシークレット", "😀😀😀", "a\u0000b", "Ωmega 🔑 key", "é"]) {
    const s = ref.utf8(text);
    run(8000 + s.length, { format: "ss1", L: s.length, n: 6, k: 4, padTo: 32, label: "utf", secret: s });
    run(8100 + s.length, { format: "plain", L: s.length, n: 6, k: 4, padTo: 0, label: null, secret: s });
  }
  t.diagnostic(`edge cases run: ${cases}, mismatches: ${mm.length}`);
  reportMismatches(mm, "edge cases");
});

prodTest("differential: combine() option handling and input hygiene", () => {
  const prod = adaptProd(loadProd());
  const mm = [];
  const secret = ref.utf8("option handling secret");
  for (const fmt of ["ss1", "plain"]) {
    const sp = ref.split(secret, 5, 3, { format: fmt, randomBytes: makeStream(31) });
    const texts = sp.shares.map((s) => s.text);
    // valid thresholds, including ones below and above the real k
    for (const thr of [undefined, 2, 3, 4, 5, 255]) {
      for (const sub of [texts.slice(0, 3), texts.slice(0, 5), texts.slice(1, 4)]) {
        combineBoth(ref, prod, mm, { fmt, thr }, sub, thr === undefined ? undefined : { threshold: thr });
      }
    }
    // invalid thresholds: plain rejects them, ss1 ignores them (SPEC 6)
    const bad = [0, 1, 256, 2.5, "3", NaN, null];
    const shapes = {
      ok: texts.slice(0, 3),
      empty: [],
      garbage: ["zz", texts[0]],
      mixed_formats: [texts[0], ref.split(secret, 3, 2, { format: fmt === "ss1" ? "plain" : "ss1", randomBytes: makeStream(5) }).shares[1].text],
      duplicates: [texts[0], texts[0], texts[1], texts[2]],
      too_few: texts.slice(0, 1),
      forged_length: [texts[0], texts[1], texts[2].replace(/-([0-9a-f]{2})([0-9a-f]+)$/, "-$2")],
    };
    for (const thr of bad) {
      for (const [name, sub] of Object.entries(shapes)) combineBoth(ref, prod, mm, { fmt, badThreshold: String(thr), shape: name }, sub, { threshold: thr });
    }
  }
  reportMismatches(mm, "option handling");
});

prodTest("differential: damaged_ss1, single character substitutions", (t) => {
  const prod = adaptProd(loadProd());
  const mm = [];
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-._".split("");
  let cases = 0;
  for (let seed = 0; seed < 12; seed++) {
    const r = makeRng(9000 + seed);
    const label = seed % 3 === 0 ? null : r.pick(["ops", "a", "my-team.2026", "vault-key", "x_y"]);
    const sp = ref.split(r.bytes(r.int(1, 6)), 3, 2, { format: "ss1", label, padTo: r.pick([0, 16]), randomBytes: makeStream(9000 + seed) });
    const text = sp.shares[0].text;
    for (let pos = 0; pos < text.length; pos++) {
      for (const ch of alphabet) {
        if (ch === text[pos]) continue;
        const bad = text.slice(0, pos) + ch + text.slice(pos + 1);
        cases++;
        const a = outcome(() => normParse(ref.parseShare(bad)));
        const b = outcome(() => normParse(prod.parseShare(bad)));
        const va = a.ok ? a.value : { code: a.code };
        const vb = b.ok ? b.value : { code: b.code };
        if (JSON.stringify(va) !== JSON.stringify(vb)) mm.push({ scenario: "damaged_ss1", seed: 9000 + seed, original: text, mutated: bad, pos, ch, reference: va, production: vb });
        for (const [who, v] of [["reference", va], ["production", vb]]) {
          if (v.format === "plain") mm.push({ scenario: "damaged_ss1 read as plain", who, seed: 9000 + seed, original: text, mutated: bad, pos, ch, parsed: v });
        }
      }
    }
  }
  t.diagnostic(`damaged_ss1 substitutions run: ${cases}, mismatches: ${mm.length}`);
  reportMismatches(mm, "damaged_ss1");
});

prodTest("differential: combine does not mutate its inputs", () => {
  const core = loadProd();
  const sp = ref.split(ref.utf8("immutability"), 4, 3, { randomBytes: makeStream(77) });
  const parsed = sp.shares.map((s) => core.parseShare(s.text));
  const snap = parsed.map((s) => hex(s.body));
  const res = core.combine(parsed.slice(0, 3));
  assert.equal(hex(res.secret), hex(ref.utf8("immutability")));
  res.secret.fill(0);
  assert.deepEqual(parsed.map((s) => hex(s.body)), snap, "combine changed share bodies");
  const again = core.combine(parsed.slice(0, 3));
  assert.equal(hex(again.secret), hex(ref.utf8("immutability")), "wiping the returned secret damaged state");
});

prodTest("differential: randomSecret against the rejection model", () => {
  const core = loadProd();
  const prod = adaptProd(core);
  const bad = [];
  for (let seed = 0; seed < 300; seed++) {
    const r = makeRng(seed);
    const length = r.pick([8, 9, 32, 33, 64, 127, 128, r.int(8, 128)]);
    // The stream is handed out sequentially. Whatever batch size the core
    // asks for, its result must equal the model applied to the served bytes.
    for (const [name, impl] of [["reference", ref], ["production", prod]]) {
      const hook = makeStream(seed + 123456);
      const served = [];
      const wrapped = (n) => {
        const b = hook(n);
        served.push(...b);
        return b;
      };
      const out = outcome(() => impl.randomSecret({ length, randomBytes: wrapped }));
      if (!out.ok) {
        bad.push({ seed, who: name, length, code: out.code });
        continue;
      }
      const want = ref.generatorModel(served).slice(0, length);
      const alphabetOk = /^[ABCDEFGHJKMNPQRTUVWXYZ234679]*$/.test(out.value);
      if (out.value.length !== length || !alphabetOk || out.value !== want) {
        bad.push({ seed, who: name, length, got: out.value, model: want, servedBytes: served.length });
      }
    }
  }
  for (const badLen of [7, 129, 0, -1, 8.5, "32", NaN]) {
    const a = outcome(() => ref.randomSecret({ length: badLen }));
    const b = outcome(() => prod.randomSecret({ length: badLen }));
    if (a.code !== b.code) bad.push({ badLen, reference: a.code, production: b.code });
  }
  const d1 = outcome(() => prod.randomSecret());
  if (!d1.ok || d1.value.length !== 32) bad.push({ defaultLength: d1 });
  assert.equal(bad.length, 0, `randomSecret mismatches: ${JSON.stringify(bad.slice(0, 5))}`);
});

prodTest("differential: live CSPRNG round trips across both implementations", () => {
  const prod = adaptProd(loadProd());
  const mm = [];
  const r = makeRng(4242);
  for (let i = 0; i < 200; i++) {
    const format = r.pick(["ss1", "plain"]);
    const L = r.int(1, 200);
    const n = r.int(2, 20);
    const k = r.int(2, n);
    const secret = r.bytes(L);
    const padTo = format === "ss1" ? r.pick(PADS) : 0;
    for (const [maker, taker, tag] of [[ref, prod, "ref->prod"], [prod, ref, "prod->ref"]]) {
      const sp = maker.split(secret, n, k, { format, padTo });
      const texts = r.shuffle(sp.shares.map((s) => s.text)).slice(0, k);
      const back = taker.combine(texts);
      if (hex(back.secret) !== hex(secret)) mm.push({ tag, format, L, n, k, padTo, texts });
      if (format === "ss1" && k > 2) {
        const out = outcome(() => taker.combine(texts.slice(0, k - 1)));
        if (out.ok || out.code !== "NOT_ENOUGH_SHARES") mm.push({ tag, step: "k-1 must fail", out });
      }
    }
  }
  reportMismatches(mm, "live round trips");
});

prodTest("differential: upstream section through both implementations", (t) => {
  const prod = adaptProd(loadProd());
  let n = 0;
  for (const u of V.upstream) {
    for (const impl of [ref, prod]) {
      for (const sub of u.subsets) {
        assert.equal(hex(impl.combine(sub.map((i) => u.shares[i])).secret), u.secretHex);
        n++;
      }
    }
    // our plain split of the same secret must be readable by the same two parsers
    const mine = ref.split(unhex(u.secretHex), u.n, u.threshold, { format: "plain", label: u.token || null, randomBytes: makeStream(u.n) });
    for (const impl of [ref, prod]) {
      assert.equal(hex(impl.combine(mine.shares.slice(0, u.threshold).map((s) => s.text)).secret), u.secretHex);
      n++;
    }
  }
  t.diagnostic(`upstream interop checks: ${n}`);
});

// Reference-only interop with upstream shares, kept outside the skip logic so a
// run without the production core still covers it.
test("reference: upstream shares combine, our plain shares look like upstream", () => {
  for (const u of V.upstream) {
    for (const sub of u.subsets) {
      assert.equal(hex(ref.combine(sub.map((i) => u.shares[i])).secret), u.secretHex);
    }
    const mine = ref.split(unhex(u.secretHex), u.n, u.threshold, { format: "plain", label: u.token || null, randomBytes: makeStream(u.n) });
    for (const s of mine.shares) assert.match(s.text, /^(?:[A-Za-z0-9._-]+-)?\d{2,3}-[0-9a-f]+$/);
    assert.equal(hex(ref.combine(mine.shares.slice(1, 1 + u.threshold).map((s) => s.text)).secret), u.secretHex);
  }
});
