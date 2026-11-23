// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Hash Check (examples/hash-check/src/app.template.html), one scene per registry screenshot.

import { area, bar, btn, dash, facts, field, footer, hero, seg, screen, step, verdict } from './common.mjs';

const NAME = 'Hash Check';
const FILE = 'sanctum-1.0.0-universal.dmg';
const SUMS = [
  ['039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81', 'sanctum-1.0.0-linux-amd64.deb'],
  ['eacfe04bc21304a30f1841b28d57f3ff58dee143c5c40569fc8e05b078100339', FILE],
  ['2b4c342f5433ebe591a1da77e013d1b72475562d48578dca8b84bac6651c3cb9', 'sanctum-1.0.0-windows-x64.msi'],
];

const top = bar(NAME);

const intro =
  hero(
    `Is it the${dash}file?`,
    'Compare a downloaded file with the checksum its publisher gave you.',
    'Installers, disk images, firmware, documents. The file is read in this window and never leaves it.',
  ) +
  facts([
    ['lock', 'Stays here', 'The file is read in small pieces and hashed on this computer. Nothing is uploaded, stored or sent.'],
    ['shield', 'Asks for nothing', 'No network, no devices, no storage. The approval screen in Sanctum is empty.'],
    ['info', 'A match has limits', 'It shows the file is the one the checksum was made from. It does not show the checksum came from the publisher.'],
  ]);

const pick = (chosen) =>
  step(
    1,
    'Choose the file',
    'Any size. Large files take a while, and you can stop at any time.',
    `<div class="tk-picker">${btn('Choose a file', { i: 'upload' })}${
      chosen ? `<span class="tk-picked"><b>${FILE}</b> (3.0 MB)</span>` : '<span class="tk-picked tk-mute">No file chosen.</span>'
    }</div>`,
  );

const sumStep = (pasted, wrong = false) =>
  step(
    2,
    'Paste the checksum',
    "Optional. Paste one checksum, or the whole contents of a file such as SHA256SUMS. Without one, the tool only shows the file's hash.",
    field(
      'Checksum from the publisher',
      pasted
        ? area(['# SHA256SUMS for release 1.0.0', ...SUMS.map(([h, n]) => `${wrong && n === FILE ? h.replace('1841b2', '18a1b2') : h}  ${n}`)])
        : area([], { placeholder: 'e3b0c442...  installer.dmg' }),
      {
        hint: pasted
          ? `Read 3 checksums. Using the line named ${FILE}.`
          : 'Reads a plain hash, sha256: hash, GNU lines (hash  name) and BSD lines (SHA256 (name) = hash).',
      },
    ) +
      field('Algorithm', seg([['SHA-256'], ['SHA-384'], ['SHA-512']], 0), {
        hint: pasted ? 'Set by the pasted checksum, which is SHA-256 by its length.' : 'SHA-256 is what most publishers use. A pasted checksum sets this by its length.',
      }),
  );

const result = (ok) =>
  step(
    3,
    'Check',
    '',
    `<div class="tk-actions">${btn('Check file', { i: 'hash' })}</div>` +
      `<p class="tk-msg">Done in ${ok ? '0.1' : '1.0'} seconds.</p>` +
      (ok
        ? verdict('ok', 'Match', "This file's SHA-256 is the same as the checksum you pasted. That shows it is the file the checksum was made from. Make sure the checksum came from the publisher by a channel you trust.")
        : verdict('bad', 'No match. Do not use this file.', '2 of 64 characters differ. Download the file again and check it once more. If it still differs, the file is not the one the publisher meant, or the checksum belongs to a different file.')) +
      `<div class="tk-out"><div class="tk-lab"><span>SHA-256 of the file</span></div><p class="tk-picked tk-mute tk-out-file">${FILE} (3.0 MB)</p><div class="tk-readout">${SUMS[1][0]}</div><div class="tk-actions tk-mt">${btn('Copy hash', { i: 'copy', kind: 'ghost', sm: true })}</div></div>`,
  );

const foot = footer('Enigma Hash Check 1.0.1. Part of Sanctum, AGPL-3.0. SHA-2 as defined in FIPS 180-4. Icons from Lucide (ISC). Fonts Inter, Poppins and Space Mono (SIL OFL 1.1).');

export default {
  name: NAME,
  screens: {
    'overview.png': screen(top, intro + pick(false) + sumStep(false)),
    'ready.png': screen(top, pick(true) + sumStep(true) + step(3, 'Check', '', `<div class="tk-actions">${btn('Check file', { i: 'hash' })}</div>`)) + foot,
    'match.png': screen(top, sumStep(true) + result(true), { scrolled: true }) + foot,
    'mismatch.png': screen(top, sumStep(true, true) + result(false), { scrolled: true }) + foot,
  },
};
