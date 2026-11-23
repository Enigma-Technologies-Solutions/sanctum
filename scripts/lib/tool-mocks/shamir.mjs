// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Shamir (examples/shamir/src/app.template.html), one scene per registry screenshot.

import { area, bar, btn, dash, details, facts, fakeHex, field, footer, hero, icon, input, notice, seg, screen, step } from './common.mjs';

const NAME = 'Shamir';
const SET = '41d2a8a4';
const share = (n, set = SET) => `demo-vault-ss1-3-${set}-${fakeHex(`${set}-${n}`, 128)}-${fakeHex(`c${set}${n}`, 4)}`;

const top = bar(NAME);
const tabs = (on) => `<div class="tk-tabs-row">${seg([['Split', 'scissors'], ['Combine', 'combine']], on, true)}</div>`;

const intro =
  hero(
    `Split${dash}combine`,
    'Split a secret into shares. Any <em>k</em> of them rebuild it.',
    "Fewer than the needed number reveal nothing about the secret's content; the size bucket and the needed number are visible in every share.",
  ) +
  facts([
    ['lock', 'Stays here', 'Everything runs in this window. Nothing is stored or sent. Closing the window discards the secret, the shares and any result.'],
    ['shield', 'Asks for nothing', 'No network, no devices, no storage. The approval screen in Sanctum is empty. Shares leave only through the clipboard.'],
    ['info', 'Checks have limits', 'Sanctum shares catch mistyped, missing and mixed shares. They do not stop a dishonest share holder.'],
  ]);

const secret = (text) =>
  step(
    1,
    'Enter the secret',
    'Type or paste it, or generate a random one. It stays hidden while you type.',
    `<div class="tk-row tk-row--end">${seg([['Text'], ['Hex']], 0)}<span class="tk-row"><span class="tk-count">${text ? text.length : 0} of 1024 bytes</span>${btn('Clear', { i: 'trash', kind: 'ghost', sm: true })}</span></div>` +
      field('Secret (text, UTF-8)', area(text ? [text] : [], { cls: 'tk-area--secret' }), {
        hint: 'Hidden while you type. Line breaks are kept.',
        after: `<div class="tk-row tk-gen">${btn(text ? 'Hide' : 'Show', { i: text ? 'eyeOff' : 'eye', kind: 'ghost', sm: true })}${btn('Generate', { i: 'dices', kind: 'ghost', sm: true })}<span class="tk-gen-len">Length ${input('32', { cls: 'tk-input--len' })}</span></div><p class="tk-hint">Generate makes a random secret from 28 easy to read letters and digits. At 32 characters that is 153.8 bits.</p>${details('Check value (SHA-256)')}`,
      }),
  );

const shares = step(
  2,
  'Choose the shares',
  'How many shares to make, and how many are needed to rebuild the secret.',
  `<div class="tk-pair">${field('Shares (n)', input('5'))}${field('Needed (k)', input('3'))}</div>` +
    '<p class="tk-sentence">Any <b>3</b> of the <b>5</b> shares rebuild the secret. 2 or fewer reveal nothing about it.</p>' +
    field('Label', input('demo-vault'), { opt: 'Optional', hint: 'Letters, digits, dot, underscore, hyphen; up to 32. Helps you tell sets apart. It is not secret and not checked.' }) +
    details('Options'),
);

const split = (done) =>
  step(
    3,
    'Split',
    '',
    `<div class="tk-actions">${btn('Split', { i: 'scissors' })}</div>` +
      (done
        ? `<div class="tk-result"><div class="tk-result-h">Shares</div><p class="tk-sumline">5 shares. Any 3 rebuild the secret. Set <b>${SET}</b>.</p><div class="tk-sharelist">${[1, 2, 3, 4, 5]
            .map((n) => `<div class="tk-share"><div class="tk-share-head"><span class="tk-share-n">Share ${n}</span>${btn('Copy', { i: 'copy', kind: 'ghost', sm: true })}</div><p class="tk-share-text">${share(n)}</p></div>`)
            .join('')}</div><div class="tk-actions">${btn('Copy all (one per line)', { i: 'copy', kind: 'ghost' })}${btn('Check these shares', { i: 'refresh', kind: 'ghost' })}${btn('Empty clipboard', { i: 'clip', kind: 'ghost' })}${btn('Clear everything', { i: 'trash', kind: 'danger' })}</div>` +
          notice('warn', 'Put each share somewhere different. Anyone holding 3 shares has the secret. Copy all puts every share on the clipboard together. Paste them somewhere temporary, separate them at once, then press Empty clipboard.') +
          '</div>'
        : ''),
  );

const PASTED_SET = 'ae077b87';
const combine =
  step(
    1,
    'Paste the shares',
    'Paste at least as many shares as were needed. Extra shares are fine.',
    field('Shares, one per line', area([1, 3, 5].map((n) => share(n, PASTED_SET)), { cls: 'tk-area--wrap' }), {
      after: `<div class="tk-parsed">${[1, 3, 5].map((n) => `<div class="tk-parsed-li">${icon('check')}<span class="tk-who">Share ${n}</span><span class="tk-sid">set ${PASTED_SET}</span><span>ok</span></div>`).join('')}</div><div class="tk-status">${icon('check')}<span>3 of 3 needed. Ready.</span></div>`,
    }),
  ) +
  step(2, 'Combine', '', `<div class="tk-actions">${btn('Combine', { i: 'combine' })}${btn('Clear', { i: 'trash', kind: 'ghost' })}</div>`) +
  `<div class="tk-block"><p class="tk-kicker">How it works</p>${details('How this works and what it does not protect')}</div>`;

const foot = footer(
  'Enigma Shamir 1.0.3. Part of Sanctum, AGPL-3.0. It asks Sanctum for no permissions.',
  "The feature set follows ssss-made-easy by Martin Carpella and 0xjjpa (GPL-3.0). The plain format and the field arithmetic match the shamir-secret-sharing package (Apache-2.0, Privy) and HashiCorp Vault's shamir package. This file was written from a specification and contains none of their code. Icons from Lucide (ISC). Fonts Inter, Poppins and Space Mono (SIL OFL 1.1).",
);

export default {
  name: NAME,
  screens: {
    'overview.png': screen(top, intro + tabs(0) + secret('')),
    'split.png': screen(top, secret('Demo secret for the screenshots. Not a real key.') + shares + split(false)),
    'shares.png': screen(top, split(true)),
    'combine.png': screen(top, tabs(1) + combine) + foot,
  },
};
