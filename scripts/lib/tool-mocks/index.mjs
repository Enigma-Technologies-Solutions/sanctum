// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Pictures of Enigma's tools for the website, drawn in HTML and CSS (see common.mjs and
// web/README.md, "Window mock-ups"). Keyed by app id, then by the registry screenshot each
// scene stands for, so a tool page shows the same scenes, in the same order and with the
// same captions, as the screenshots listed in registry/apps/<app_id>/app.json. A screenshot
// with no scene here is shown as the image itself.
//
// When a tool's interface changes, change its module here too.

import hashCheck from './hash-check.mjs';
import otpVault from './otp-vault.mjs';
import pdfWatermark from './pdf-watermark.mjs';
import shamir from './shamir.mjs';

export const TOOLS = {
  'sh.enigma.hash-check': hashCheck,
  'sh.enigma.otp-vault': otpVault,
  'sh.enigma.pdf-watermark': pdfWatermark,
  'sh.enigma.shamir': shamir,
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The scene for one screenshot (its file name, such as "overview.png"), or null. */
export function toolScene(appId, file) {
  return TOOLS[appId]?.screens[file] ?? null;
}

/**
 * One scene in a window on a tinted stage. `caption` names the figure: visible under the
 * stage on a tool's page, visually hidden on the home page. `size` is a .mock-window
 * modifier (short, tall, xl).
 */
export function toolFigure(appId, file, { caption, size = 'xl', visibleCaption = true, cls = '' }) {
  const scene = toolScene(appId, file);
  if (!scene) throw new Error(`no mock for ${appId} ${file}`);
  const window = `<div class="mock-window mock-window--${size}" aria-hidden="true"><div class="mock-window__frame"><div class="mock-window__bar"><span class="mock-window__lights"><i></i><i></i><i></i></span><span class="mock-window__title">${esc(TOOLS[appId].name)}</span></div><div class="mock-window__screen tk">${scene}</div></div></div>`;
  return visibleCaption
    ? `<figure class="mock tool-shot${cls ? ` ${cls}` : ''}"><div class="mock-stage">${window}</div><figcaption class="tool-shot__cap">${esc(caption)}</figcaption></figure>`
    : `<figure class="mock mock-stage${cls ? ` ${cls}` : ''}">${window}<figcaption class="sr">${esc(caption)}</figcaption></figure>`;
}
