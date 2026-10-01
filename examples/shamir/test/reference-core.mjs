// Independent reference for the Sanctum Shamir contract. Test-only.
//
// Written from the spec text alone, for differential testing against
// src/shamir-core.js. Structure is deliberately different from a direct port:
// GF(256) runs on log/antilog tables (generator 3, modulus 0x11b), SHA-256
// comes from node:crypto, and the combine path is a single pipeline over
// parsed records. Nothing here is shipped.

import { createHash, randomFillSync } from "node:crypto";

// ---------------------------------------------------------------- errors

export class RefError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = "RefError";
    this.code = code;
    this.details = details || {};
  }
}
const fail = (code, details, message) => {
  throw new RefError(code, message || code, details);
};

// ---------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    let twice = v << 1;
    if (twice & 0x100) twice ^= 0x11b;
    v = (twice ^ v) & 0xff; // times 3
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
export function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}
export function gfInv(a) {
  if (a === 0) throw new RangeError("inverse of zero");
  return EXP[255 - LOG[a]];
}
function gfDiv(a, b) {
  if (b === 0) throw new RangeError("divide by zero");
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
}

// ---------------------------------------------------------------- bytes

const enc = new TextEncoder();
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function cat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return s;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function sha256(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

const TAG_PREFIX = ascii("sanctum-shamir/v1/tag");
const SHARE_PREFIX = ascii("sanctum-shamir/v1/share");

function tagOf(lenBytes, secret) {
  return sha256(cat(TAG_PREFIX, lenBytes, secret)).subarray(0, 4);
}

function checksumOf(k, setIdBytes, body) {
  return toHex(sha256(cat(SHARE_PREFIX, Uint8Array.of(k), setIdBytes, body)).subarray(0, 2));
}

// ---------------------------------------------------------------- random

function defaultRandomBytes(n) {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) randomFillSync(out.subarray(at, Math.min(n, at + 65536)));
  return out;
}

const ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ234679";
const PADS = [0, 16, 32, 64, 128, 256];

// ---------------------------------------------------------------- labels

export function labelOk(label) {
  if (typeof label !== "string") return false;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(label)) return false;
  return !label.split("-").some((seg) => seg.toLowerCase() === "ss1");
}

// ---------------------------------------------------------------- split

export function split(secret, n, k, options) {
  const o = options || {};
  if (!(secret instanceof Uint8Array)) throw new TypeError("secret must be a Uint8Array");
  if (secret.length === 0) fail("SECRET_EMPTY");
  if (secret.length > 1024) fail("SECRET_TOO_LONG", { max: 1024, have: secret.length });
  if (!Number.isInteger(n) || n < 2 || n > 255) fail("BAD_SHARE_COUNT", { min: 2, max: 255, have: n });
  if (!Number.isInteger(k) || k < 2 || k > n) fail("BAD_THRESHOLD", { min: 2, max: n, have: k });

  const format = o.format === undefined ? "ss1" : o.format;
  if (format !== "ss1" && format !== "plain") fail("BAD_OPTION", { option: "format" });
  const label = o.label === undefined || o.label === null ? null : o.label;
  if (label !== null && !labelOk(label)) fail("BAD_OPTION", { option: "label" });
  const padTo = o.padTo === undefined ? 0 : o.padTo;
  if (!PADS.includes(padTo)) fail("BAD_OPTION", { option: "padTo" });
  if (format === "plain" && padTo !== 0) fail("BAD_OPTION", { option: "padTo" });
  if (o.randomBytes !== undefined && typeof o.randomBytes !== "function") {
    fail("BAD_OPTION", { option: "randomBytes" });
  }
  const rb = o.randomBytes || defaultRandomBytes;

  let setIdBytes = null;
  let payload;
  if (format === "ss1") {
    setIdBytes = rb(4);
    const L = secret.length;
    const base = 2 + L + 4;
    const total = padTo === 0 ? base : Math.ceil(base / padTo) * padTo;
    const lenBytes = Uint8Array.of(L >> 8, L & 255);
    payload = new Uint8Array(total);
    payload.set(lenBytes, 0);
    payload.set(secret, 2);
    payload.set(tagOf(lenBytes, secret), total - 4);
  } else {
    payload = Uint8Array.from(secret);
  }
  const P = payload.length;
  const rand = rb(P * (k - 1));

  // Evaluate each byte's polynomial at x = 1..n, Horner, highest term first.
  const bodies = [];
  for (let x = 1; x <= n; x++) bodies.push(new Uint8Array(P + 1));
  for (let i = 0; i < P; i++) {
    const row = i * (k - 1);
    for (let x = 1; x <= n; x++) {
      let acc = 0;
      for (let j = k - 1; j >= 1; j--) acc = gfMul(acc, x) ^ rand[row + j - 1];
      bodies[x - 1][i] = gfMul(acc, x) ^ payload[i];
    }
  }
  const setId = setIdBytes ? toHex(setIdBytes) : null;
  const shares = bodies.map((body, idx) => {
    const x = idx + 1;
    body[P] = x;
    return {
      format,
      label,
      x,
      threshold: format === "ss1" ? k : null,
      setId,
      body,
      text: shareText(format, label, x, k, setIdBytes, body),
    };
  });
  return { shares, format, threshold: k, setId, payloadBytes: P };
}

function shareText(format, label, x, k, setIdBytes, body) {
  const head = label ? label + "-" : "";
  if (format === "plain") {
    return head + (x < 10 ? "0" : "") + x + "-" + toHex(body);
  }
  return head + "ss1-" + k + "-" + toHex(setIdBytes) + "-" + toHex(body) + "-" + checksumOf(k, setIdBytes, body);
}

// Used by the test harness to forge shares with a valid checksum.
export function buildSs1Text(label, k, setIdHex, body) {
  return shareText("ss1", label, body[body.length - 1], k, hexToBytes(setIdHex), body);
}

// ---------------------------------------------------------------- parse

const SS1_RE = /^(?:([A-Za-z0-9._-]{1,32})-)?ss1-(\d{1,3})-([0-9a-f]{8})-([0-9a-f]+)-([0-9a-f]{4})$/i;
const HEX_RE = /^(?:[0-9a-f]{2})*$/i;

export function parseShare(input) {
  const text = String(input).trim();
  if (text === "") fail("EMPTY_INPUT");

  const m = SS1_RE.exec(text);
  if (m) {
    const [, label, kText, setIdText, bodyText, chk] = m;
    const k = parseInt(kText, 10);
    if (String(k) !== kText || k < 2 || k > 255) fail("BAD_THRESHOLD");
    if (bodyText.length % 2 !== 0) fail("BAD_HEX");
    if (bodyText.length / 2 < 8) fail("SHARE_TOO_SHORT");
    const body = hexToBytes(bodyText);
    const x = body[body.length - 1];
    if (x === 0) fail("X_OUT_OF_RANGE");
    const setIdBytes = hexToBytes(setIdText);
    if (checksumOf(k, setIdBytes, body) !== chk.toLowerCase()) fail("BAD_CHECKSUM");
    const setId = setIdText.toLowerCase();
    const lab = label === undefined ? null : label;
    return {
      format: "ss1",
      label: lab,
      x,
      threshold: k,
      setId,
      body,
      text: shareText("ss1", lab, x, k, setIdBytes, body),
    };
  }

  if (text.split("-").some((seg) => seg.toLowerCase() === "ss1")) fail("BAD_SYNTAX");

  const cut = text.lastIndexOf("-");
  const head = cut < 0 ? "" : text.slice(0, cut);
  const bodyText = cut < 0 ? text : text.slice(cut + 1);
  if (bodyText === "") fail("BAD_SYNTAX");
  if (!HEX_RE.test(bodyText)) fail("BAD_HEX");
  if (bodyText.length / 2 < 2) fail("SHARE_TOO_SHORT");
  const body = hexToBytes(bodyText);
  const x = body[body.length - 1];
  if (x === 0) fail("X_OUT_OF_RANGE");
  // Prefix rule: empty, or [LABEL-]NN (NN 1 to 3 digits, LABEL 0 to 32 chars),
  // or a bare label of 1 to 32 chars without dashes. Anything else is damage.
  let label = null;
  if (head !== "") {
    const hm = /^(?:([A-Za-z0-9._-]{0,32})-)?(\d{1,3})$/.exec(head);
    if (hm) label = hm[1] || null;
    else if (/^[A-Za-z0-9._]{1,32}$/.test(head)) label = head;
    else fail("BAD_SYNTAX");
  }
  return { format: "plain", label, x, threshold: null, setId: null, body, text: shareText("plain", label, x, 0, null, body) };
}

// ---------------------------------------------------------------- combine

// Value at abscissa X of the polynomial through the points (xs[i], ys[i][b]).
function interpolateAt(X, xs, ys, len) {
  const t = xs.length;
  const w = new Array(t);
  for (let i = 0; i < t; i++) {
    let num = 1;
    let den = 1;
    for (let j = 0; j < t; j++) {
      if (j === i) continue;
      num = gfMul(num, X ^ xs[j]);
      den = gfMul(den, xs[i] ^ xs[j]);
    }
    w[i] = gfDiv(num, den);
  }
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < t; i++) acc ^= gfMul(ys[i][b], w[i]);
    out[b] = acc;
  }
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function combine(texts, options) {
  const o = options || {};
  const thr = o.threshold === undefined || o.threshold === null ? undefined : o.threshold;
  if (!Array.isArray(texts) || texts.length === 0) fail("NO_SHARES");

  const parsed = texts.map((t, index) => {
    if (typeof t !== "string") return t;
    try {
      return parseShare(t);
    } catch (e) {
      if (e instanceof RefError) e.details = { ...e.details, index };
      throw e;
    }
  });

  const fmt = parsed[0].format;
  if (parsed.some((s) => s.format !== fmt)) fail("MIXED_FORMATS");
  // SPEC 6: options.threshold is for plain only ("ignored for ss1"), so it is
  // validated only once the set is known to be plain.
  if (fmt === "plain" && thr !== undefined && (!Number.isInteger(thr) || thr < 2 || thr > 255)) {
    fail("BAD_OPTION", { option: "threshold" });
  }

  // keep first occurrence of each exact duplicate, remember its input index
  const kept = [];
  let ignoredDuplicates = 0;
  parsed.forEach((s, index) => {
    if (kept.some((q) => q.s.x === s.x && sameBytes(q.s.body, s.body))) ignoredDuplicates++;
    else kept.push({ s, index });
  });

  if (fmt === "ss1") {
    const a = kept[0].s;
    if (kept.some((q) => q.s.setId !== a.setId || q.s.threshold !== a.threshold)) fail("MIXED_SETS");
  }
  if (kept.some((q) => q.s.body.length !== kept[0].s.body.length)) fail("LENGTH_MISMATCH");
  const seen = new Map();
  for (const q of kept) {
    if (seen.has(q.s.x)) fail("DUPLICATE_X", { x: q.s.x });
    seen.set(q.s.x, true);
  }

  const need = fmt === "ss1" ? kept[0].s.threshold : thr !== undefined ? thr : 2;
  if (kept.length < need) fail("NOT_ENOUGH_SHARES", { have: kept.length, need });

  const t = fmt === "ss1" ? need : thr !== undefined ? thr : kept.length;
  const base = kept.slice(0, t);
  const extras = kept.slice(t);
  const len = kept[0].s.body.length - 1;
  const xs = base.map((q) => q.s.x);
  const ys = base.map((q) => q.s.body.subarray(0, len));

  const payload = interpolateAt(0, xs, ys, len);
  const mismatches = [];
  for (const q of extras) {
    const want = interpolateAt(q.s.x, xs, ys, len);
    if (!sameBytes(want, q.s.body.subarray(0, len))) mismatches.push(q.index);
  }

  if (fmt === "plain") {
    if (mismatches.length > 0) fail("INCONSISTENT_SHARES", { indices: mismatches });
    return {
      secret: payload,
      format: "plain",
      threshold: thr !== undefined ? thr : null,
      setId: null,
      verified: false,
      sharesUsed: t,
      ignoredDuplicates,
      warnings: [],
    };
  }

  const P = payload.length;
  const L = (payload[0] << 8) | payload[1];
  const bad = () => fail("INTEGRITY_FAILED", { extraMismatch: mismatches });
  if (L < 1 || 2 + L + 4 > P) bad();
  for (let i = 2 + L; i < P - 4; i++) if (payload[i] !== 0) bad();
  const secret = payload.slice(2, 2 + L);
  if (!sameBytes(payload.subarray(P - 4), tagOf(payload.subarray(0, 2), secret))) bad();
  return {
    secret,
    format: "ss1",
    threshold: kept[0].s.threshold,
    setId: kept[0].s.setId,
    verified: true,
    sharesUsed: t,
    ignoredDuplicates,
    warnings: mismatches.length ? [{ code: "EXTRA_SHARE_MISMATCH", inputIndices: mismatches }] : [],
  };
}

// ---------------------------------------------------------------- generator

export function randomSecret(opts) {
  const o = opts || {};
  const length = o.length === undefined ? 32 : o.length;
  if (!Number.isInteger(length) || length < 8 || length > 128) fail("BAD_OPTION", { option: "length" });
  if (o.randomBytes !== undefined && typeof o.randomBytes !== "function") fail("BAD_OPTION", { option: "randomBytes" });
  const rb = o.randomBytes || defaultRandomBytes;
  let out = "";
  while (out.length < length) {
    const chunk = rb(length - out.length);
    for (let i = 0; i < chunk.length && out.length < length; i++) {
      if (chunk[i] < 252) out += ALPHABET[chunk[i] % 28];
    }
  }
  return out;
}

// Model of the rejection rule, for checking another implementation's output
// against the bytes it was handed.
export function generatorModel(bytes) {
  let out = "";
  for (const b of bytes) if (b < 252) out += ALPHABET[b % 28];
  return out;
}

export const utf8 = (s) => enc.encode(s);
