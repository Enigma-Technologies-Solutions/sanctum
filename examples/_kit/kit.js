// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Enigma tool kit: the theme switch. Inlined at build time by examples/_kit/kit.mjs.
//
// Every tool opens light. A button marked data-theme-toggle switches this window to dark
// and back. The choice is not kept anywhere: it lives in an attribute on <html> and ends
// with the window, so the kit adds no capability to the tool that inlines it.
(function () {
  "use strict";
  var root = document.documentElement;
  var COLORS = { light: "#FFFFFF", dark: "#0B0C0E" };

  function current() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function setTheme(theme) {
    var t = theme === "dark" ? "dark" : "light";
    root.setAttribute("data-theme", t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", COLORS[t]);
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].setAttribute("aria-pressed", t === "dark" ? "true" : "false");
    }
    return t;
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest("[data-theme-toggle]") : null;
    if (b) setTheme(current() === "dark" ? "light" : "dark");
  });

  setTheme(current());
  globalThis.EnigmaKit = { setTheme: setTheme, theme: current };
})();
