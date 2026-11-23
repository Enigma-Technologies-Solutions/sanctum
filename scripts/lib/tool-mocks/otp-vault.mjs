// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// OTP Vault (examples/otp-vault/src/app.template.html), one scene per registry screenshot.
// The vault fingerprint is eight emoji in the tool. The website shows no emoji, so each
// picture is drawn as a neutral shape instead.

import { area, bar, btn, check, facts, field, footer, hero, input, notice, seg, screen, step } from './common.mjs';

const NAME = 'OTP Vault';
const USER = 'demo@example.com';
// One shape per fingerprint cell: [shape, shade].
const PICTURE = [['round', 1], ['square', 2], ['ring', 3], ['diamond', 1], ['square', 3], ['round', 2], ['diamond', 3], ['ring', 1]];

const shape = ([s, t]) => `<i class="tk-shape tk-shape--${s} tk-shade${t}"></i>`;
const fpMini = `<span class="tk-fp-mini">${PICTURE.map(shape).join('')}</span>`;
const session = `<span class="tk-session"><span class="tk-who">${USER}</span>${fpMini}${btn('Lock', { i: 'lock', kind: 'ghost', sm: true })}</span>`;

const plain = bar(NAME);
const signedIn = bar(NAME, session);

const intro =
  hero(
    'Codes that <span class="tk-hl">stay here</span>',
    'Two-factor codes, generated inside Sanctum.',
    "Your username and password derive an AES-256 key that encrypts every secret before it is written to this tool's own storage. With a YubiKey and smart card access approved, secrets can live on the key instead, and the key computes each code.",
  ) +
  notice('', "Sanctum gives this tool its own storage, tied to the tool's identity in your library. A new version of the tool keeps the vault. Deleting the tool from Sanctum and adding it again starts with empty storage, so copy a backup first.") +
  facts([
    ['lock', 'Stays here', 'Your username and password never leave this window. Secrets are encrypted before they are stored, and codes are computed on this computer.'],
    ['shield', 'Asks for two things', 'Its own storage for the encrypted vault and, only if you use it, the OATH applet of a YubiKey. No network.'],
    ['alert', 'No recovery', 'If the password is forgotten, the stored secrets cannot be decrypted. Keep a backup and a long password.'],
  ]);

const dots = (n) => '•'.repeat(n);

const fingerprint = (shown) =>
  `<div class="tk-fp"><div class="tk-fp-label">Vault fingerprint</div><div class="tk-fp-grid${shown ? '' : ' tk-fp-grid--empty'}">${PICTURE.map((p) => `<div>${shown ? shape(p) : '?'}</div>`).join('')}</div><div class="tk-fp-hex">${shown ? '602b b689 f3b4 a7d9' : 'Not computed yet.'}</div><p>A one-way value derived from the same master key as the encryption key. It reveals nothing about the password or the key. It only gives you a picture to recognise: different input, different picture.</p></div>`;

const gate = (filled) =>
  step(
    1,
    'Create a vault',
    'Choose a username and password. They never leave this page. Press Show fingerprint and note the eight emoji: you will see the same ones every time you enter this combination.',
    `<div class="tk-tabs-row">${seg([['Unlock'], ['Create vault']], 1, true)}</div>` +
      `<div class="tk-grid2"><div class="tk-card">` +
      field('Username', input(filled ? USER : ''), { hint: 'Not case-sensitive. Used only on this computer, with the password, to derive the key.' }) +
      field('Password', input(filled ? dots(26) : ''), { after: `<div class="tk-meter"><i${filled ? '' : ' class="tk-meter--none"'}></i></div>` }) +
      field('Confirm password', input(filled ? dots(26) : '')) +
      `<div class="tk-field"><ul class="tk-plain"><li>There is no recovery. If the password is forgotten, the stored secrets cannot be decrypted.</li><li>Use at least 12 characters. A passphrase of four or more random words works well.</li><li>The same username and password always produce the same fingerprint and key, on any device.</li></ul>${check('I have noted the fingerprint shown for this username and password.', { on: filled })}</div>` +
      `<div class="tk-actions">${btn('Show fingerprint', { i: 'eye', kind: 'ghost' })}${btn('Create vault')}</div>` +
      (filled ? '<p class="tk-msg tk-msg--ok">Note these eight emoji, then confirm below.</p>' : '') +
      `</div>${fingerprint(filled)}</div>`,
  );

const ENTRIES = [
  ['Northwind Cloud', USER, '660 828', '552 854'],
  ['Contoso Mail', 'demo.user@example.org', '879 090', '073 988'],
  ['Fabrikam Git', 'demo', '362 055', '012 541'],
  ['Example Bank', '1234 5678', '672 704', '916 982'],
];

const codes =
  step(
    3,
    'Use a code',
    'Click a code to copy it. A code turns red in the last five seconds of its window.',
    `<div class="tk-toolbar">${input('', { placeholder: 'Filter by service or account' })}<span class="tk-small">4 of 4</span></div>` +
      `<div class="tk-list">${ENTRIES.map(
        ([s, a, c, n]) =>
          `<div class="tk-entry"><div><div class="tk-issuer">${s}</div><div class="tk-acct">${a}</div></div><div class="tk-code">${c}</div><div class="tk-bar-t"><i></i></div><div class="tk-entry-foot"><span class="tk-next">19s · next ${n}</span><span class="tk-entry-actions">${btn('Rename', { kind: 'ghost', sm: true })}${btn('Delete', { kind: 'danger', sm: true })}</span></div></div>`,
      ).join('')}</div>`,
  ) +
  step(
    4,
    'Codes from your YubiKey',
    "The YubiKey OATH applet keeps each secret inside the key and returns only the code. Nothing about these accounts is stored in this tool. This needs Sanctum's smart card access, approved for the <b>OATH (TOTP/HOTP)</b> applet only.",
    notice('', "Smart card access is not available to this tool. In Sanctum, open this tool's permissions and approve <b>talk to your smart card: OATH (TOTP/HOTP) [a0000005272101]</b>, then reopen the window. Outside Sanctum this step stays off."),
  );

const BACKUP = [
  '{"format":"ets-otp-vault/v1-backup","exported":"2026-11-23T06:14:00.101Z","id":"29687eda046d272ac369fb6027133ad3","record":{"format":"ets-otp-vault/v1","kdf":{"name":"PBKDF2-SHA-256","iterations":600000},"box":{"iv":"ALCF73qncoKXeso1","ct":"Qnww2Yt/BBNFZxdtxujoHvuSBXPddgYxAo+a6zDitru2ksYp5Udq0OUdV6g/XPgjN',
];

const settings = step(
  5,
  'Back up and look after the vault',
  '',
  '<div class="tk-grid2">' +
    `<div class="tk-card tk-card--wide"><div class="tk-card-h">Copy a backup</div><p>Copy the encrypted vault to the clipboard as JSON, then paste it into a file or a password manager note. It stays encrypted, and the same username and password open it. Accounts stored on a YubiKey are not part of the backup.</p>${btn('Copy backup', { i: 'copy', kind: 'ghost' })}${area(BACKUP, { cls: 'tk-area--wrap tk-area--backup' })}<p class="tk-msg tk-msg--ok">Encrypted backup copied. Paste it somewhere safe.</p></div>` +
    `<div class="tk-card"><div class="tk-card-h">Change the password</div><p>Everything is encrypted again under a new key, and the fingerprint changes.</p>${field('New password', input('', { placeholder: '' }))}${field('Confirm new password', input('', { placeholder: '' }))}${btn('Change password', { kind: 'ghost' })}</div>` +
    `<div class="tk-card"><div class="tk-card-h">Delete the vault</div><p>Remove this vault from this tool's storage. Without a backup, this cannot be undone.</p>${btn('Delete vault', { kind: 'danger' })}</div>` +
    '</div>',
);

const foot = footer(
  'Enigma OTP Vault 1.0.3. Part of Sanctum, AGPL-3.0. Codes are TOTP as defined in RFC 6238. Icons from Lucide (ISC). Fonts Inter, Poppins and Space Mono (SIL OFL 1.1).',
  'Key derivation: PBKDF2-SHA-256, 600,000 iterations, salt bound to the username, then HKDF-SHA-256 into an AES-256-GCM key and a separate fingerprint value.',
);

export default {
  name: NAME,
  screens: {
    'overview.png': screen(plain, intro + gate(false)),
    'create-vault.png': screen(plain, gate(true)),
    'codes.png': screen(signedIn, codes),
    'backup.png': screen(signedIn, settings) + foot,
  },
};
