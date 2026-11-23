// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Registry screenshots of Shamir, drawn by scripts/tool-screens.mjs:
//   node scripts/tool-screens.mjs shamir
// Each scene runs inside the page with the helpers that script provides ($, type, press,
// until, pickFile, scrollToEl). The secret is made up for the pictures.

const SECRET = 'Demo secret for the screenshots. Not a real key.';

// Fill in step 1 and step 2 and show the secret.
const FILL = `
  type("#secret", ${JSON.stringify(SECRET)});
  press("#sToggle");
  type("#label", "demo-vault");
`;

// Split, and wait for the shares.
const SPLIT = `${FILL}
  press("#btnSplit");
  await until(function () { return !$("#splitResult").hidden; });
  // The tool focuses the result heading, which scrolls the page; scrollToEl expects the top.
  document.activeElement.blur();
  window.scrollTo(0, 0);
`;

export default {
  appId: 'sh.enigma.shamir',
  scenes: {
    'overview.png': ``,
    'split.png': `${FILL}
      scrollToEl("#h-secret");`,
    'shares.png': `${SPLIT}
      scrollToEl("#h-split");`,
    'combine.png': `${SPLIT}
      var shares = Array.prototype.map.call(document.querySelectorAll("#shareList .share-text"), function (p) { return p.textContent; });
      press("#tabCombine");
      type("#shares", [shares[0], shares[2], shares[4]].join("\\n"));
      await until(function () { return !$("#btnCombine").disabled; });
      document.activeElement.blur();
      window.scrollTo(0, 0);
      scrollToEl("#app .tabs");`,
  },
};
