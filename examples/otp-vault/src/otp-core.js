"use strict";
const ETSCore = (() => {
  const APP = "ets-otp-vault/v1";
  const ITERATIONS = 600000;
  const te = new TextEncoder();
  const td = new TextDecoder();
  const subtle = globalThis.crypto && globalThis.crypto.subtle;

  // 256 emoji, one per byte value. Order is part of the format: never reorder.
  const EMOJI = Array.from("🐶🐱🐭🐰🦊🐻🐨🐯🦁🐷🐸🐔🐧🐦🦆🦅🦉🐺🐗🐴🐝🐛🐌🐞🐜🦂🐢🐍🦖🦕🦑🦐🦞🐡🐠🐟🐳🐋🦈🐅🐆🦍🐘🦛🐪🐫🦒🐃🐂🐄🐖🐏🦙🐐🦌🐩🐈🐓🦚🦜🦩🐇🦝🦡🦦🦥🐀🦔🍏🍐🍊🍌🍉🍇🍈🍒🍑🍍🥥🍅🍆🥑🥬🥒🌽🧄🧅🥔🥐🥯🥖🥨🧀🍳🧈🥞🥓🥩🍗🌭🍔🍕🥪🥙🌮🌯🥗🥫🍝🍲🍛🍣🥟🦪🍤🍚🍘🍥🥮🍢🍧🍨🍦🧁🍰🎂🍭🍬🍿🍩🍪🥜🍯🥛☕🍵🧃🍶🍺🥂🍷🥃🍹🧉🍾🌵🎄🌲🌴🌱🍀🎍🎋🍂🍁🍄🌾💐🌹🥀🌺🌼🌻🌞🌛🌜🌚🌙🌎💫⭐🌟⚡🔥🌈🌊💧☔⚽🏀⚾🥎🎾🏉🥏🎱🏸🏒🏏🥅⛳🏹🎣🥊🎽🛹🛼🥌🎿🎮🎲🧩🎨🧵🧶🎹🥁🎺🎸🪕🚗🚕🚙🚓🚑🚒🚚🚜🚲🛴🚨🛸🚁⛵🛶⚓🚢🏰🗼⛪🕌🔔🔒💡🔦📱💻💎🔮🎁🎀🧲🧪⏰⌛📚📎🔭🧸🪀🪄🎩👓🧢👠🧤");

  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const toB64 = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const normUser = (u) => String(u).normalize("NFKC").trim().toLowerCase();
  const normPass = (p) => String(p).normalize("NFKC");
  const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

  // Storage id for a username. Keeps usernames out of localStorage keys.
  async function vaultId(username) {
    return toHex(await sha256(te.encode(APP + "|id|" + normUser(username)))).slice(0, 32);
  }

  // username + password -> { key: AES-GCM CryptoKey (non-extractable), fingerprint: 32 bytes }
  async function deriveVaultKeys(username, password, iterations = ITERATIONS) {
    const salt = await sha256(te.encode(APP + "|salt|" + normUser(username)));
    const pw = await subtle.importKey("raw", te.encode(normPass(password)), "PBKDF2", false, ["deriveBits"]);
    const master = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, pw, 256);
    const ikm = await subtle.importKey("raw", master, "HKDF", false, ["deriveKey", "deriveBits"]);
    const zero = new Uint8Array(32);
    const key = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: zero, info: te.encode(APP + "|aes-gcm") },
      ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const fingerprint = new Uint8Array(await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: zero, info: te.encode(APP + "|fingerprint") }, ikm, 256));
    return { key, fingerprint };
  }

  const fingerprintEmoji = (fp, n = 8) => Array.from(fp.slice(0, n), (b) => EMOJI[b]);
  const fingerprintHex = (fp, n = 8) => toHex(fp.slice(0, n)).match(/.{4}/g).join(" ");

  async function seal(key, id, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(APP + "|" + id) }, key, te.encode(JSON.stringify(obj))));
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  // Throws if the key is wrong or the record was altered.
  async function open(key, id, box) {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(box.iv), additionalData: te.encode(APP + "|" + id) }, key, fromB64(box.ct));
    return JSON.parse(td.decode(pt));
  }

  // ---------- TOTP ----------
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function cleanBase32(s) {
    return String(s).toUpperCase().replace(/[\s\-_.]/g, "").replace(/=+$/, "");
  }

  function base32Decode(input) {
    const s = cleanBase32(input);
    if (!s) throw new Error("The key is empty.");
    const bad = s.match(/[^A-Z2-7]/);
    if (bad) throw new Error('"' + bad[0] + '" is not a valid key character. Keys use A to Z and 2 to 7.');
    let bits = 0, value = 0;
    const out = [];
    for (const c of s) {
      value = (value << 5) | B32.indexOf(c);
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    if (out.length < 10) throw new Error("The key is too short (at least 16 characters expected).");
    return new Uint8Array(out);
  }

  function base32Encode(bytes) {
    let bits = 0, value = 0, out = "";
    for (const b of bytes) {
      value = (value << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  const ALGOS = { "SHA1": "SHA-1", "SHA-1": "SHA-1", "SHA256": "SHA-256", "SHA-256": "SHA-256", "SHA512": "SHA-512", "SHA-512": "SHA-512" };

  async function hotp(secret, counter, digits = 6, algorithm = "SHA-1") {
    const key = await subtle.importKey("raw", secret, { name: "HMAC", hash: algorithm }, false, ["sign"]);
    const msg = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) { msg[i] = c % 256; c = Math.floor(c / 256); }
    const h = new Uint8Array(await subtle.sign("HMAC", key, msg));
    const o = h[h.length - 1] & 0x0f;
    const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
  }

  async function totp(secret, { digits = 6, period = 30, algorithm = "SHA-1" } = {}, nowMs = Date.now()) {
    const counter = Math.floor(nowMs / 1000 / period);
    return hotp(secret, counter, digits, algorithm);
  }

  // Accepts a bare base32 key or an otpauth://totp/ URI. Returns normalised entry fields.
  function parseKeyInput(text) {
    const t = String(text).trim();
    if (/^otpauth:\/\//i.test(t)) {
      const u = new URL(t);
      if (u.host.toLowerCase() !== "totp") throw new Error("Only time-based (totp) links are supported.");
      const label = decodeURIComponent(u.pathname.replace(/^\//, ""));
      const p = u.searchParams;
      let issuer = p.get("issuer") || "";
      let account = label;
      const i = label.indexOf(":");
      if (i >= 0) { if (!issuer) issuer = label.slice(0, i).trim(); account = label.slice(i + 1).trim(); }
      const algorithm = ALGOS[(p.get("algorithm") || "SHA1").toUpperCase()];
      if (!algorithm) throw new Error("Unsupported algorithm in link.");
      const digits = parseInt(p.get("digits") || "6", 10);
      const period = parseInt(p.get("period") || "30", 10);
      const secret = cleanBase32(p.get("secret") || "");
      base32Decode(secret);
      return { issuer, account, secret, digits, period, algorithm, fromUri: true };
    }
    const secret = cleanBase32(t);
    base32Decode(secret);
    return { secret, fromUri: false };
  }

  function validateParams({ digits, period, algorithm }) {
    if (![6, 7, 8].includes(digits)) throw new Error("Digits must be 6, 7 or 8.");
    if (!(Number.isInteger(period) && period >= 10 && period <= 300)) throw new Error("Period must be 10 to 300 seconds.");
    if (!["SHA-1", "SHA-256", "SHA-512"].includes(algorithm)) throw new Error("Unsupported algorithm.");
  }

  // ---------- YubiKey OATH applet ----------
  // Wire format follows Yubico's OATH protocol as implemented in yubikit
  // (yubikit/oath.py). Every function here builds or parses bytes; talking to
  // the card is the app's job, through window.sanctum.smartcard.
  const OATH_AID = "a0000005272101";
  const OT = { NAME: 0x71, NAME_LIST: 0x72, KEY: 0x73, CHALLENGE: 0x74, RESPONSE: 0x75,
    TRUNCATED: 0x76, HOTP: 0x77, PROPERTY: 0x78, VERSION: 0x79, TOUCH: 0x7c };
  const OATH_ALGO = { "SHA-1": 0x01, "SHA-256": 0x02, "SHA-512": 0x03 };
  const OATH_TOTP = 0x20;
  const fromHex = (h) => new Uint8Array((String(h).match(/../g) || []).map((x) => parseInt(x, 16)));

  function tlv(tag, value) {
    const v = Array.from(value);
    const n = v.length;
    const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
    return [tag, ...len, ...v];
  }

  function parseTlv(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      const tag = bytes[i++];
      let n = bytes[i++];
      if (n === 0x81) n = bytes[i++];
      else if (n === 0x82) { n = (bytes[i] << 8) | bytes[i + 1]; i += 2; }
      if (n === undefined || i + n > bytes.length) throw new Error("Malformed response from the key.");
      out.push({ tag, value: bytes.slice(i, i + n) });
      i += n;
    }
    return out;
  }

  function oathApdu(ins, p1, p2, data) {
    const d = data || [];
    if (d.length > 255) throw new Error("Command is too long for the key.");
    return toHex([0x00, ins, p1, p2, ...(d.length ? [d.length, ...d] : [])]);
  }

  function timeStep(nowMs, period) {
    let c = Math.floor(nowMs / 1000 / period);
    const b = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { b[i] = c % 256; c = Math.floor(c / 256); }
    return b;
  }

  // "30/" prefix is omitted for the default period, like yubikit's _format_cred_id.
  function oathCredId({ issuer = "", account = "", period = 30 }) {
    const name = (account || issuer).trim();
    const iss = account ? issuer.trim() : "";
    if (!name) throw new Error("Give the account a name.");
    const id = te.encode((period !== 30 ? period + "/" : "") + (iss ? iss + ":" : "") + name);
    if (id.length > 64) throw new Error("Service and account together are too long for the key (64 bytes).");
    return id;
  }

  function parseCredId(bytes, totp = true) {
    const s = td.decode(bytes);
    if (totp) {
      const m = /^((\d+)\/)?(([^:]+):)?(.+)$/.exec(s);
      if (m) return { issuer: m[4] || "", account: m[5], period: m[2] ? parseInt(m[2], 10) : 30 };
      return { issuer: "", account: s, period: 30 };
    }
    const i = s.indexOf(":");
    return i > 0 ? { issuer: s.slice(0, i), account: s.slice(i + 1), period: 0 } : { issuer: "", account: s, period: 0 };
  }

  function truncatedCode(v) {
    const digits = v[0];
    const bin = ((v[1] << 24) | (v[2] << 16) | (v[3] << 8) | v[4]) & 0x7fffffff;
    return String(bin % 10 ** digits).padStart(digits, "0");
  }

  function parseSelect(bytes) {
    const t = Object.fromEntries(parseTlv(bytes).map((x) => [x.tag, x.value]));
    const v = t[OT.VERSION];
    return { version: v ? Array.from(v).join(".") : "", salt: t[OT.NAME] || null, challenge: t[OT.CHALLENGE] || null };
  }

  async function oathPut(entry, secret, touch = false) {
    const algo = OATH_ALGO[entry.algorithm];
    if (!algo) throw new Error("Unsupported algorithm for the key.");
    let key = secret;
    const block = entry.algorithm === "SHA-512" ? 128 : 64;
    if (key.length > block) key = new Uint8Array(await subtle.digest(entry.algorithm, key));
    const padded = new Uint8Array(Math.max(14, key.length));
    padded.set(key);
    const data = [...tlv(OT.NAME, oathCredId(entry)), ...tlv(OT.KEY, [OATH_TOTP | algo, entry.digits, ...padded])];
    if (touch) data.push(OT.PROPERTY, 0x02);
    return oathApdu(0x01, 0, 0, data);
  }

  const oathDelete = (id) => oathApdu(0x02, 0, 0, tlv(OT.NAME, id));
  const oathList = () => oathApdu(0xa1, 0, 0);
  const oathCalculateAll = (nowMs) => oathApdu(0xa4, 0, 1, tlv(OT.CHALLENGE, timeStep(nowMs, 30)));
  const oathCalculate = (id, nowMs, period) =>
    oathApdu(0xa2, 0, 1, [...tlv(OT.NAME, id), ...tlv(OT.CHALLENGE, timeStep(nowMs, period))]);

  // CALCULATE ALL answers NAME followed by one of TRUNCATED, HOTP or TOUCH per credential.
  function parseCalculateAll(bytes) {
    const items = parseTlv(bytes);
    const out = [];
    for (let i = 0; i + 1 < items.length; i += 2) {
      if (items[i].tag !== OT.NAME) throw new Error("Unexpected response layout from the key.");
      const id = items[i].value, r = items[i + 1];
      const hotp = r.tag === OT.HOTP;
      const c = { id, ...parseCredId(id, !hotp), type: hotp ? "hotp" : "totp", touch: r.tag === OT.TOUCH, code: null };
      if (r.tag === OT.TRUNCATED && r.value.length === 5) c.code = truncatedCode(r.value);
      out.push(c);
    }
    return out;
  }

  // LIST answers one NAME_LIST per credential: [type | algorithm, ...name]. It
  // does not say which credentials need a touch; CALCULATE ALL does.
  function parseList(bytes) {
    return parseTlv(bytes).filter((x) => x.tag === OT.NAME_LIST).map((x) => {
      const id = x.value.slice(1), hotp = (x.value[0] & 0xf0) === 0x10;
      return { id, ...parseCredId(id, !hotp), type: hotp ? "hotp" : "totp", touch: null, code: null };
    });
  }

  function parseCalculate(bytes) {
    const t = parseTlv(bytes).find((x) => x.tag === OT.TRUNCATED);
    if (!t || t.value.length !== 5) throw new Error("The key did not return a code.");
    return truncatedCode(t.value);
  }

  // Password-protected applet: prove knowledge of the password, and check the key's answer.
  async function oathValidate(password, salt, challenge) {
    const pw = await subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
    const raw = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt, iterations: 1000 }, pw, 128);
    const k = await subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const response = new Uint8Array(await subtle.sign("HMAC", k, challenge));
    const mine = crypto.getRandomValues(new Uint8Array(8));
    const expected = new Uint8Array(await subtle.sign("HMAC", k, mine));
    return { apdu: oathApdu(0xa3, 0, 0, [...tlv(OT.RESPONSE, response), ...tlv(OT.CHALLENGE, mine)]), expected };
  }

  function oathCheckValidate(bytes, expected) {
    const t = parseTlv(bytes).find((x) => x.tag === OT.RESPONSE);
    if (!t || t.value.length !== expected.length) return false;
    let d = 0;
    for (let i = 0; i < expected.length; i++) d |= t.value[i] ^ expected[i];
    return d === 0;
  }

  const oath = { AID: OATH_AID, tlv, parseTlv, timeStep, credId: oathCredId, parseCredId, parseSelect, put: oathPut,
    del: oathDelete, list: oathList, parseList, calculateAll: oathCalculateAll, calculate: oathCalculate, parseCalculateAll, parseCalculate,
    validate: oathValidate, checkValidate: oathCheckValidate };

  return { APP, ITERATIONS, EMOJI, vaultId, deriveVaultKeys, fingerprintEmoji, fingerprintHex, seal, open,
    base32Decode, base32Encode, cleanBase32, hotp, totp, parseKeyInput, validateParams, toHex, fromHex, oath };
})();
if (typeof module !== "undefined") module.exports = ETSCore;
