// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// The core of the template tool: counts words, lines and characters in a text. Replace it with
// your tool's own logic. Keep the same shape: no DOM, no imports, no network, plain functions
// that the tests in test/ can call from Node and the page can call from the browser.
(function (root) {
  "use strict";

  var SPLIT = {
    // Words are runs of characters between spaces, tabs and line breaks.
    space: /\s+/u,
    // Words are runs of letters and digits; punctuation also separates them.
    punct: /[^\p{L}\p{N}'’]+/u,
  };

  /** Whether the bytes look like a binary file rather than text: any NUL byte in the first 8 KB. */
  function looksBinary(bytes) {
    var n = Math.min(bytes.length, 8192);
    for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }

  /** Count a text. `split` is "space" (the default) or "punct". */
  function countText(text, split) {
    var re = SPLIT[split || "space"];
    if (!re) throw new Error("unknown split: " + split);
    var s = String(text);
    var words = s.split(re).filter(function (w) { return w.length > 0; }).length;
    var lines = s === "" ? 0 : s.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(s) ? 1 : 0);
    var chars = Array.from(s).length;
    var bytes = new TextEncoder().encode(s).length;
    return { words: words, lines: lines, chars: chars, bytes: bytes };
  }

  /** One line that sums up a count, for the result panel and the copy button. */
  function summary(c) {
    function n(v, one, many) { return v + " " + (v === 1 ? one : many); }
    return [n(c.words, "word", "words"), n(c.lines, "line", "lines"), n(c.chars, "character", "characters"), n(c.bytes, "byte", "bytes") + " in UTF-8"].join(", ");
  }

  var api = { countText: countText, looksBinary: looksBinary, summary: summary };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ToolCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
