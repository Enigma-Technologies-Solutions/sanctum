// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Evaluate the core as a CommonJS style script, as Hash Check's tests do.
const mod = { exports: {} };
new Function("module", readFileSync(join(here, "..", "src", "otp-core.js"), "utf8"))(mod);
const C = mod.exports;

const ascii = (s) => new TextEncoder().encode(s);

// RFC 6238, appendix B. The seeds are the ASCII digits repeated to the hash's length.
const SEEDS = {
  "SHA-1": ascii("12345678901234567890"),
  "SHA-256": ascii("12345678901234567890123456789012"),
  "SHA-512": ascii("1234567890123456789012345678901234567890123456789012345678901234"),
};
const VECTORS = [
  [59, { "SHA-1": "94287082", "SHA-256": "46119246", "SHA-512": "90693936" }],
  [1111111109, { "SHA-1": "07081804", "SHA-256": "68084774", "SHA-512": "25091201" }],
  [1234567890, { "SHA-1": "89005924", "SHA-256": "91819424", "SHA-512": "93441116" }],
  [20000000000, { "SHA-1": "65353130", "SHA-256": "77737706", "SHA-512": "47863826" }],
];

test("TOTP matches the RFC 6238 test vectors", async () => {
  for (const [t, codes] of VECTORS) {
    for (const [algorithm, want] of Object.entries(codes)) {
      assert.equal(await C.totp(SEEDS[algorithm], { digits: 8, period: 30, algorithm }, t * 1000), want, `${algorithm} at ${t}`);
    }
  }
});

test("base32 round trips and rejects bad keys", () => {
  const bytes = ascii("12345678901234567890");
  const b32 = C.base32Encode(bytes);
  assert.equal(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(C.base32Decode(b32.toLowerCase().match(/.{1,4}/g).join(" ")), bytes);
  assert.throws(() => C.base32Decode("GEZDGNBV1Y3TQOJQ"), /not a valid key character/);
  assert.throws(() => C.base32Decode("GEZDGNBV"), /too short/);
});

test("otpauth links are read", () => {
  const p = C.parseKeyInput("otpauth://totp/Example:alice@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&digits=8&period=60&algorithm=SHA256");
  assert.equal(p.issuer, "Example");
  assert.equal(p.account, "alice@example.com");
  assert.equal(p.digits, 8);
  assert.equal(p.period, 60);
  assert.equal(p.algorithm, "SHA-256");
  assert.throws(() => C.parseKeyInput("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ"), /totp/);
});

test("key derivation is deterministic and sealed records reject tampering", async () => {
  const a = await C.deriveVaultKeys("Alice ", "correct horse", 1000);
  const b = await C.deriveVaultKeys("alice", "correct horse", 1000);
  const c = await C.deriveVaultKeys("alice", "correct horse!", 1000);
  assert.deepEqual(a.fingerprint, b.fingerprint);
  assert.notDeepEqual(a.fingerprint, c.fingerprint);
  assert.equal(C.EMOJI.length, 256);
  assert.equal(C.fingerprintEmoji(a.fingerprint).length, 8);
  const id = await C.vaultId("alice");
  assert.match(id, /^[0-9a-f]{32}$/);
  const box = await C.seal(a.key, id, { entries: [1, 2] });
  assert.deepEqual(await C.open(b.key, id, box), { entries: [1, 2] });
  await assert.rejects(C.open(c.key, id, box));
  await assert.rejects(C.open(a.key, "0".repeat(32), box));
});

test("OATH credential ids follow yubikit", () => {
  const td = new TextDecoder();
  assert.equal(td.decode(C.oath.credId({ issuer: "Example", account: "alice", period: 30 })), "Example:alice");
  assert.equal(td.decode(C.oath.credId({ issuer: "Example", account: "alice", period: 60 })), "60/Example:alice");
  assert.deepEqual(C.oath.parseCredId(ascii("60/Example:alice")), { issuer: "Example", account: "alice", period: 60 });
});
