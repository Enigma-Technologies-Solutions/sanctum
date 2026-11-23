// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Registry screenshots for OTP Vault, drawn by scripts/tool-screens.mjs:
//   node scripts/tool-screens.mjs otp-vault
// Each scene runs in the built page after the tool has started. The accounts, keys and
// password below are made up for the pictures. The page runs from a temporary file in a
// fresh headless Chrome, so its storage starts empty. The clipboard is stubbed in the
// backup scene only, because headless Chrome refuses it and the tool would show its
// fallback message instead.

// Chrome draws the picture when its virtual time runs out, and virtual time runs on while the
// page waits for Web Crypto, which works off the main thread. Yielding through a message
// channel keeps the page busy, so virtual time stands still until the work is done.
const WAIT = `
  async function settle(fn) {
    var ch = new MessageChannel();
    for (var n = 0; !fn(); n++) {
      if (n > 20000000) throw new Error("scene timed out");
      await new Promise(function (r) { ch.port1.onmessage = function () { r(); }; ch.port2.postMessage(0); });
    }
  }
`;

const USER = "demo@example.com";
const PASS = "lantern orbit cobalt meadow";

// Create a vault and wait until the fingerprint is shown.
const CREATE = `${WAIT}
  press("#tabCreate");
  type("#gUser", ${JSON.stringify(USER)});
  type("#gPass", ${JSON.stringify(PASS)});
  type("#gPass2", ${JSON.stringify(PASS)});
  press("#btnPreview");
  await settle(function () { return !$("#fpGrid").classList.contains("empty") && !$("#btnPreview").disabled; });
  $("#ackFp").checked = true;
  $("#ackFp").dispatchEvent(new Event("change", { bubbles: true }));
`;

const KEYS = [
  ["Northwind Cloud", "demo@example.com", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"],
  ["Contoso Mail", "demo.user@example.org", "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U"],
  ["Fabrikam Git", "demo", "KRSXG5CTMVRXEZLUKN2XAZLSONSWG4TF"],
  ["Example Bank", "1234 5678", "ONSWG4TFOQQGC3TEEBZWKY3SMV2HE33V"],
];

// Open the vault and add the demo keys one by one. The clock is moved forward by less than one
// window so that each countdown stands at 18 seconds, which shows the bar part way down.
const OPEN_WITH_KEYS = `${CREATE}
  var realNow = Date.now, shift = (12000 - realNow() % 30000 + 30000) % 30000;
  Date.now = function () { return realNow() + shift; };
  press("#btnGate");
  await settle(function () { return !$("#vault").hidden; });
  var keys = ${JSON.stringify(KEYS)};
  for (var k = 0; k < keys.length; k++) {
    type("#aIssuer", keys[k][0]);
    type("#aAccount", keys[k][1]);
    type("#aSecret", keys[k][2]);
    $("#addForm").requestSubmit();
    await settle(function () { return $("#list").children.length === k + 1; });
  }
  await settle(function () { return !/-/.test($("#list .code").textContent); });
  document.activeElement.blur();
`;

export default {
  appId: "sh.enigma.otp-vault",
  scenes: {
    "overview.png": ``,
    "create-vault.png": `${CREATE}
      scrollToEl("#h-gate");`,
    "codes.png": `${OPEN_WITH_KEYS}
      scrollToEl("#h-codes");`,
    "backup.png": `
      navigator.clipboard.writeText = function () { return Promise.resolve(); };
      ${OPEN_WITH_KEYS}
      press("#btnExport");
      await settle(function () { return !$("#exportText").hidden; });
      scrollToEl("#h-settings");`,
  },
};
