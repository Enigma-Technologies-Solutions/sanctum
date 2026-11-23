// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// PDF Watermark (examples/pdf-watermark/src/app.template.html), one scene per registry
// screenshot. The preview canvas is drawn in CSS: a page of grey text lines, a photo box,
// and the tiled red text turned to the angle set on the left.

import { bar, btn, check, dash, details, facts, field, footer, hero, input, seg, screen, step } from './common.mjs';

const NAME = 'PDF Watermark';
const FOR = 'Northwind Lettings';

const top = bar(NAME);

const intro =
  hero(
    `Mark every${dash}copy.`,
    'Put a visible watermark on PDFs before you share them, with an ID that is different for each file and a name on every page.',
    'Passports, visas, contracts. It all happens in this window.',
  ) +
  facts([
    ['lock', 'Stays here', 'Your PDFs are read and rewritten in this window. Nothing is uploaded, stored or sent anywhere.'],
    ['shield', 'Asks for nothing', 'No network, no devices, no storage. The approval screen in Sanctum is empty.'],
    ['info', 'Deterrence only', 'Someone with a PDF editor can remove these marks, and a printout or screenshot drops the hidden ones.'],
  ]);

const choose = step(
  1,
  'Choose your PDFs',
  'Pick as many as you like. Each file is marked on its own.',
  `<div class="tk-picker">${btn('Choose PDF files', { i: 'upload' })}<span class="tk-small tk-mute">Up to 200 MB each. Password protected files must be unlocked first.</span></div>`,
);

const range = (label, value, pos) => `<div class="tk-field"><div class="tk-lab"><span>${label}</span><span class="tk-val">${value}</span></div><span class="tk-range tk-range--${pos}"><i></i></span></div>`;

const TILE = `CONFIDENTIAL · DO NOT SHARE · K7M2Q9XA4D-3F9A · 2026-11-23 · ${FOR} · `;
const preview = (name) =>
  `<div class="tk-card"><div class="tk-page"><div class="tk-page-stamp">K7M2Q9XA4D-3F9A · Page 1 of 1</div><div class="tk-page-text"></div><div class="tk-page-photo"></div><div class="tk-page-tiles">${Array.from(
    { length: 15 },
    (_, k) => `<span>${(name ? TILE : TILE.replace(` · ${FOR}`, '')).repeat(3).slice((k * 17) % 40)}</span>`,
  ).join('')}</div></div><p class="tk-hint tk-center">A4 page, as a viewer shows it.</p></div>`;

const settings = (name) =>
  step(
    2,
    'Set the watermark',
    'The preview shows how the tiling lies on a page. The ID shown is an example.',
    '<div class="tk-cols"><div class="tk-card">' +
      field('Who is this copy for?', input(name ? FOR : '', { placeholder: 'A name or a case number' }), {
        hint: 'Required. It is printed on every page, so a leaked copy leads back to the person it was made for.',
      }) +
      field(
        'Colour',
        seg(
          ['red', 'black', 'grey', 'blue'].map((c) => [`<i class="tk-swatch tk-swatch--${c}"></i>${c[0].toUpperCase()}${c.slice(1)}`]),
          0,
        ),
      ) +
      `<div class="tk-pair tk-pair--ranges">${range('Strength', '22%', 'a')}${range('Angle', '35°', 'b')}${range('Text size', '18 pt', 'c')}${range('Spacing', '60 pt', 'd')}</div>` +
      check('Corner stamps', { on: true, small: 'The ID and page number at the top left and bottom right of every page.' }) +
      check('Bottom band', { small: 'A light strip along the bottom edge that says who the copy was shared with.' }) +
      check('Sensitive zones', { small: 'Closer marks over the bottom quarter of each page, where the machine readable lines of a passport usually are. The text stays readable.' }) +
      details('Wording') +
      `</div>${preview(name)}</div>`,
  );

const FILES = [
  ['tenancy-agreement.pdf', '4.4 KB, 4 pages', 'RPRN3RC83E-761E', '761e923316d9'],
  ['passport-copy.pdf', '1.6 KB, 1 page', '83KV15YASN-B01A', 'b01a2df36488'],
  ['bank-statement-october.pdf', '3.5 KB, 3 pages', 'EKV49GX2HT-2554', '255452ce9953'],
  ['employment-contract.pdf', '6.2 KB, 6 pages', 'MQ5M0N8N0S-BB06', 'bb064b524e6c'],
];

const queue = (done) =>
  step(
    3,
    'Mark and save',
    'Marked files are saved to your Downloads folder. The original files are never changed.',
    done
      ? `<div class="tk-files">${FILES.map(
          ([n, m, id, fp]) =>
            `<div class="tk-file"><div class="tk-file-head"><div><div class="tk-file-name">${n}</div><p class="tk-file-meta">${m}</p></div><span class="tk-done">Done</span></div><div class="tk-ids"><span>ID <b>${id}</b></span><span>Fingerprint <b>${fp}</b></span><span>For <b>${FOR}</b></span></div><div class="tk-actions tk-actions--tight">${btn('Save', { i: 'download', sm: true })}${btn('Remove', { i: 'x', kind: 'ghost', sm: true })}</div></div>`,
        ).join('')}</div><div class="tk-actions">${btn('Watermark all', { i: 'stamp', kind: 'off' })}${btn('Save all as ZIP', { i: 'archive', kind: 'ghost' })}${btn('Clear all', { i: 'trash', kind: 'ghost' })}</div>` +
          `<div class="tk-receipt">${check('Put a receipt in the ZIP', { on: true, small: 'A small <span class="tk-code-s">receipt.json</span> with each ID, recipient and file fingerprint. It holds no document content.' })}</div><p class="tk-msg tk-msg--ok">4 files marked.</p>`
      : '<p class="tk-empty">No files yet. Choose PDFs in step 1.</p>',
  );

const foot = footer('Enigma PDF Watermark v1.0.1. Part of Sanctum, AGPL-3.0. Uses pdf-lib (MIT) to write the PDFs. Icons from Lucide (ISC). Fonts Inter, Poppins and Space Mono (SIL OFL 1.1).');

export default {
  name: NAME,
  screens: {
    'overview.png': screen(top, intro + choose + settings(false)),
    'settings.png': screen(top, settings(true) + queue(false)),
    'results.png': screen(top, queue(true)) + foot,
  },
};
