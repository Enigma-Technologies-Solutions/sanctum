import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// The repo root may set "type": "module", which would load a .js file as ESM and skip
// module.exports. Evaluate the file as a CommonJS style script in this realm instead.
const mod = { exports: {} };
new Function("module", readFileSync(join(here, "..", "src", "hash-core.js"), "utf8"))(mod);
const core = mod.exports;
const { createHasher, hashHex, parseChecksums, pickEntry, compareHex, toHex, algForHexLength } = core;

const enc = (s) => new TextEncoder().encode(s);
const ALGS = ["sha256", "sha384", "sha512"];

// Known answers from FIPS 180-4 / NIST example values and the empty message.
const KNOWN = {
  sha256: {
    "": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    abc: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq": "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
  sha384: {
    "": "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b",
    abc: "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
  },
  sha512: {
    "": "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
    abc: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  },
};

test("known answers", () => {
  for (const alg of ALGS) {
    for (const [msg, want] of Object.entries(KNOWN[alg])) {
      assert.equal(hashHex(alg, enc(msg)), want, `${alg} of ${JSON.stringify(msg.slice(0, 12))}`);
    }
  }
});

test("one million 'a' (FIPS 180-4 long message)", () => {
  const a = new Uint8Array(1_000_000).fill(0x61);
  assert.equal(hashHex("sha256", a), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert.equal(
    hashHex("sha512", a),
    "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b",
  );
});

test("every length around the block and padding boundaries matches Node", () => {
  for (const alg of ALGS) {
    for (let n = 0; n <= 300; n++) {
      const b = randomBytes(n);
      assert.equal(hashHex(alg, new Uint8Array(b)), createHash(alg).update(b).digest("hex"), `${alg} length ${n}`);
    }
  }
});

test("random messages up to a few hundred KB match Node", () => {
  for (const alg of ALGS) {
    for (let i = 0; i < 12; i++) {
      const n = Math.floor(Math.random() * 300_000);
      const b = randomBytes(n);
      assert.equal(hashHex(alg, new Uint8Array(b)), createHash(alg).update(b).digest("hex"), `${alg} length ${n}`);
    }
  }
});

test("splitting the input into pieces never changes the answer", () => {
  const b = randomBytes(5000);
  for (const alg of ALGS) {
    const want = createHash(alg).update(b).digest("hex");
    for (const step of [1, 3, 63, 64, 65, 127, 128, 129, 1000, 4999, 5000]) {
      const h = createHasher(alg);
      for (let i = 0; i < b.length; i += step) h.update(new Uint8Array(b.subarray(i, Math.min(i + step, b.length))));
      assert.equal(toHex(h.digest()), want, `${alg} step ${step}`);
    }
    // Uneven pieces, including empty ones.
    const h = createHasher(alg);
    let at = 0;
    while (at < b.length) {
      const take = Math.floor(Math.random() * 400);
      h.update(new Uint8Array(b.subarray(at, Math.min(at + take, b.length))));
      at += take;
    }
    assert.equal(toHex(h.digest()), want, `${alg} uneven`);
  }
});

test("a sub-array view hashes only its own bytes", () => {
  const b = randomBytes(1000);
  const view = new Uint8Array(b.buffer, b.byteOffset + 100, 300);
  assert.equal(hashHex("sha256", view), createHash("sha256").update(b.subarray(100, 400)).digest("hex"));
});

test("the length counter is right past 2^32 bits", () => {
  // 600 MiB of zeros in 1 MiB steps: bit length exceeds 2^32. Compared with Node on the same input.
  const alg = "sha256";
  const chunk = new Uint8Array(1 << 20);
  const mine = createHasher(alg);
  const node = createHash(alg);
  for (let i = 0; i < 600; i++) {
    mine.update(chunk);
    node.update(chunk);
  }
  assert.equal(toHex(mine.digest()), node.digest("hex"));
});

test("a finished hasher refuses more input and a second digest", () => {
  const h = createHasher("sha256");
  h.update(enc("x"));
  h.digest();
  assert.throws(() => h.update(enc("y")), { code: "finished" });
  assert.throws(() => h.digest(), { code: "finished" });
});

test("bad input is refused with a code", () => {
  assert.throws(() => createHasher("md5"), { code: "unknown_algorithm" });
  assert.throws(() => createHasher("sha256").update("text"), { code: "bad_input" });
});

test("digest lengths", () => {
  assert.equal(createHasher("sha256").digest().length, 32);
  assert.equal(createHasher("sha384").digest().length, 48);
  assert.equal(createHasher("sha512").digest().length, 64);
  assert.equal(algForHexLength(64), "sha256");
  assert.equal(algForHexLength(96), "sha384");
  assert.equal(algForHexLength(128), "sha512");
  assert.equal(algForHexLength(40), null);
});

// ------------------------------------------------------------ pasted checksums

const H256 = KNOWN.sha256.abc;
const H512 = KNOWN.sha512.abc;

test("a bare hash is read and its algorithm comes from its length", () => {
  const r = parseChecksums(`  ${H256.toUpperCase()}  \n`);
  assert.deepEqual(r.entries, [{ hex: H256, alg: "sha256", name: null }]);
  assert.equal(parseChecksums(H512).entries[0].alg, "sha512");
});

test("GNU, BSD and prefixed forms", () => {
  assert.deepEqual(parseChecksums(`${H256}  linux.iso`).entries, [{ hex: H256, alg: "sha256", name: "linux.iso" }]);
  assert.deepEqual(parseChecksums(`${H256} *linux.iso`).entries, [{ hex: H256, alg: "sha256", name: "linux.iso" }]);
  assert.deepEqual(parseChecksums(`SHA256 (linux.iso) = ${H256}`).entries, [{ hex: H256, alg: "sha256", name: "linux.iso" }]);
  assert.deepEqual(parseChecksums(`SHA-512 (a b.iso) = ${H512}`).entries, [{ hex: H512, alg: "sha512", name: "a b.iso" }]);
  assert.deepEqual(parseChecksums(`sha256:${H256}`).entries, [{ hex: H256, alg: "sha256", name: null }]);
});

test("hash grouped with spaces or colons is read", () => {
  const spaced = H256.match(/.{8}/g).join(" ");
  const colon = H256.match(/.{2}/g).join(":");
  assert.equal(parseChecksums(spaced).entries[0].hex, H256);
  assert.equal(parseChecksums(colon).entries[0].hex, H256);
});

test("a tag that disagrees with the length is not guessed", () => {
  const r = parseChecksums(`SHA512 (x) = ${H256}`);
  assert.equal(r.entries.length, 0);
  assert.equal(r.ignored, 1);
  assert.equal(parseChecksums(`sha512:${H256}`).entries.length, 0);
});

test("MD5 and SHA-1 are recognised and left out, never treated as a match", () => {
  const r = parseChecksums("d41d8cd98f00b204e9800998ecf8427e  a\nda39a3ee5e6b4b0d3255bfef95601890afd80709  b\nSHA1 (c) = da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(r.entries.length, 0);
  assert.deepEqual(r.unsupported, ["MD5", "SHA-1", "SHA-1"]);
});

test("a SHA256SUMS file with comments, blank lines and junk", () => {
  const text = `# release 1.2\n\n${H256}  one.iso\n${KNOWN.sha256[""]}  ./two.iso\nnot a checksum line\n`;
  const r = parseChecksums(text);
  assert.equal(r.entries.length, 2);
  assert.equal(r.ignored, 1);
});

test("windows line endings", () => {
  assert.equal(parseChecksums(`${H256}  a\r\n${H256}  b\r\n`).entries.length, 2);
});

test("non-hex text of the right length is not a checksum", () => {
  assert.equal(parseChecksums("z".repeat(64)).entries.length, 0);
  assert.equal(parseChecksums("").entries.length, 0);
});

test("picking the entry for a file", () => {
  const e = parseChecksums(`${H256}  one.iso\n${KNOWN.sha256[""]}  dir/two.iso`).entries;
  assert.equal(pickEntry(e, "two.iso").how, "name");
  assert.equal(pickEntry(e, "two.iso").entry.hex, KNOWN.sha256[""]);
  assert.equal(pickEntry(e, "C:\\Users\\me\\one.iso").entry.hex, H256);
  assert.equal(pickEntry(e, "three.iso").how, "ambiguous");
  assert.equal(pickEntry(e, "three.iso").entry, null);
  const one = parseChecksums(H256).entries;
  assert.equal(pickEntry(one, "anything.bin").how, "only");
  assert.equal(pickEntry([], "x").how, "none");
});

test("a list of one that names a different file is still offered as the only entry", () => {
  const e = parseChecksums(`${H256}  other.iso`).entries;
  assert.equal(pickEntry(e, "mine.iso").how, "only");
});

test("two lines for one name are ambiguous", () => {
  const e = parseChecksums(`${H256}  a.iso\n${KNOWN.sha256[""]}  a.iso`).entries;
  assert.equal(pickEntry(e, "a.iso").how, "ambiguous");
});

test("comparing hashes counts the differing characters", () => {
  assert.deepEqual(compareHex("abcd", "abcd"), { equal: true, different: 0 });
  assert.deepEqual(compareHex("abcd", "abce"), { equal: false, different: 1 });
  assert.equal(compareHex("abcd", "abc").equal, false);
});
