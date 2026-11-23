// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Building blocks for the pictures of Enigma's tools on the website. Each tool's window is
// drawn in HTML and CSS (the .tk-* classes in web/styles.css, which copy the light theme of
// examples/_kit/kit.css) instead of shown as a screenshot. Everything here is decorative:
// the window is aria-hidden and the figure is named by its caption, so nothing inside may
// take focus. Use <span> and <div> for buttons and fields, never <a>, <button> or <input>.
//
// Copy inside a mock is the tool's real interface text. Data is made up, as in the
// registry screenshots. No emoji: the OTP Vault fingerprint is drawn as neutral shapes.

/** Lucide icons (ISC), the same ones the tools carry in their sprites. */
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  cross: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  tick: '<path d="M20 6 9 17l-5-5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  combine: '<path d="M10 18H5a3 3 0 0 1-3-3v-1"/><path d="M14 2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2"/><path d="M20 2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2"/><path d="m7 21 3-3-3-3"/><rect x="14" y="14" width="8" height="8" rx="2"/><rect x="2" y="2" width="8" height="8" rx="2"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  dices: '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  clip: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  stamp: '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13"/>',
};

/** An inline Lucide icon. */
export function icon(name) {
  const body = ICONS[name];
  if (!body) throw new Error(`tool mock: no icon ${name}`);
  return `<svg class="i" viewBox="0 0 24 24">${body}</svg>`;
}

/** The kit's header bar: ETS mark, ENIGMA / TOOL NAME, the theme switch. `extra` sits before the switch. */
export function bar(tool, extra = '') {
  return `<div class="tk-bar"><div class="tk-wrap tk-bar-in"><span class="tk-mark"><span class="tk-ets">ETS</span><span class="tk-word">Enigma <b>/</b> ${tool}</span></span><span class="tk-bar-end">${extra}<span class="tk-theme">${icon('moon')}</span></span></div></div>`;
}

/** Hero: the eyebrow, the title (with its volt accent already marked up) and the lede. */
export function hero(title, lead, rest) {
  return `<div class="tk-hero"><p class="tk-eyebrow">Tool for Sanctum</p><div class="tk-h1">${title}</div><p class="tk-lede">${lead} <span>${rest}</span></p></div>`;
}

export const dash = '<span class="tk-dash"></span>';

/** Three info boxes: [icon, title, text]. */
export function facts(items) {
  return `<div class="tk-facts">${items.map(([i, h, p]) => `<div class="tk-fact"><div class="tk-fact-h">${icon(i)}${h}</div><p>${p}</p></div>`).join('')}</div>`;
}

/** A numbered step: the head, the optional sub line, then the body. */
export function step(n, title, sub, body = '', cls = '') {
  return `<div class="tk-block${cls ? ` ${cls}` : ''}"><div class="tk-step"><span class="tk-n">${n}</span><span class="tk-h2">${title}</span></div>${sub ? `<p class="tk-sub">${sub}</p>` : '<div class="tk-gap"></div>'}${body}</div>`;
}

/** A button. kind: '' (volt), 'ghost', 'danger', 'off'. */
export function btn(label, { i, kind = '', sm = false } = {}) {
  const cls = ['tk-btn', kind && `tk-btn--${kind}`, sm && 'tk-btn--sm'].filter(Boolean).join(' ');
  return `<span class="${cls}">${i ? icon(i) : ''}${label}</span>`;
}

/** A segmented control or tab row: [label, icon?], with the index of the selected one. */
export function seg(items, on, tabs = false) {
  return `<span class="tk-seg${tabs ? ' tk-seg--tabs' : ''}">${items.map(([l, i], k) => `<span${k === on ? ' class="on"' : ''}>${i ? icon(i) : ''}${l}</span>`).join('')}</span>`;
}

/** A labelled field. `control` is the input's markup; `opt` the right-hand label text; `after` more markup inside the field. */
export function field(label, control, { hint = '', opt = '', after = '' } = {}) {
  return `<div class="tk-field"><div class="tk-lab"><span>${label}</span>${opt ? `<span class="tk-opt">${opt}</span>` : ''}</div>${control}${hint ? `<p class="tk-hint">${hint}</p>` : ''}${after}</div>`;
}

/** A text input, filled with `value` or showing `placeholder`. */
export function input(value, { placeholder = '', cls = '' } = {}) {
  return value
    ? `<div class="tk-input${cls ? ` ${cls}` : ''}">${value}</div>`
    : `<div class="tk-input tk-input--ph${cls ? ` ${cls}` : ''}">${placeholder}</div>`;
}

/** A text area: lines of text (monospace, as in the kit), or a placeholder. */
export function area(lines, { placeholder = '', cls = '' } = {}) {
  const body = lines.length ? lines.join('\n') : `<span class="tk-ph">${placeholder}</span>`;
  return `<div class="tk-area${cls ? ` ${cls}` : ''}">${body}</div>`;
}

/** Result panel. kind: 'ok', 'bad' or ''. */
export function verdict(kind, title, text) {
  return `<div class="tk-verdict${kind ? ` tk-verdict--${kind}` : ''}">${icon(kind === 'bad' ? 'cross' : kind === 'ok' ? 'check' : 'info')}<div><strong>${title}</strong><p>${text}</p></div></div>`;
}

/** Notice above a work area. kind: '' (information), 'warn', 'bad'. */
export function notice(kind, text) {
  return `<div class="tk-notice${kind ? ` tk-notice--${kind}` : ''}">${icon(kind ? 'alert' : 'info')}<div>${text}</div></div>`;
}

/** A checkbox row. */
export function check(label, { on = false, small = '' } = {}) {
  return `<div class="tk-check"><span class="tk-box${on ? ' on' : ''}">${on ? icon('tick') : ''}</span><span>${label}${small ? `<small>${small}</small>` : ''}</span></div>`;
}

/** A closed <details>: just its summary. */
export function details(summary) {
  return `<div class="tk-details"><span class="tk-sum">${summary}</span></div>`;
}

export function footer(...paras) {
  return `<div class="tk-foot"><div class="tk-wrap">${paras.map((p) => `<p>${p}</p>`).join('')}</div></div>`;
}

/**
 * The window's content: the header bar, then the column as if scrolled to that point. With
 * `scrolled`, the first lines slide under the header bar, as in a window scrolled part way
 * into a step.
 */
export function screen(barHtml, body, { scrolled = false } = {}) {
  return `${barHtml}<div class="tk-main${scrolled ? ' tk-main--scrolled' : ''}"><div class="tk-wrap">${body}</div></div>`;
}

/**
 * Deterministic made-up hex, so the demo values look random but never change between builds
 * (a changing page would fail the --check in CI).
 */
export function fakeHex(seed, length) {
  let x = 0;
  for (const c of String(seed)) x = (Math.imul(x ^ c.charCodeAt(0), 2654435761) + 0x9e3779b9) >>> 0;
  let out = '';
  while (out.length < length) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out += x.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}
