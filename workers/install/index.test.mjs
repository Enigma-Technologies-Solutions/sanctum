// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIdFromPath, handle, installUrl } from './index.mjs';

const get = (path, init) => handle(new Request(`https://enigmahq.sh${path}`, init));

test('a valid app id gets the install page with a link that opens Sanctum', async () => {
  const r = get('/install/sh.enigma.shamir');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  const html = await r.text();
  assert.ok(html.includes('href="sanctum://install?app=sh.enigma.shamir"'));
  assert.ok(html.includes('href="https://sanctum.enigma.sh/apps/sh.enigma.shamir/"'));
  assert.ok(html.includes('releases/latest'), 'a way to get Sanctum');
  assert.match(html, /Nothing is installed from this page/);
  assert.match(html, /no access/);
});

test('a trailing slash is fine', async () => {
  assert.equal(get('/install/sh.enigma.shamir/').status, 200);
});

test('the page makes no automatic attempt to open Sanctum and runs no script', async () => {
  const html = await get('/install/sh.enigma.shamir').text();
  assert.ok(!/<script/i.test(html));
  assert.ok(!/http-equiv\s*=\s*"?refresh/i.test(html), 'opening Sanctum needs the user to click');
  assert.ok(!/\son\w+\s*=/i.test(html));
  assert.ok(!/[–—]/.test(html), 'no en or em dash in copy');
});

test('every response carries the locked-down headers', async () => {
  for (const path of ['/install/sh.enigma.shamir', '/install/nope', '/_/install.css']) {
    const r = get(path);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.doesNotMatch(csp, /script-src|unsafe-inline|unsafe-eval/, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
  }
});

test('anything that is not a valid app id is a plain 404 that echoes nothing', async () => {
  const bad = [
    '/install/',
    '/install',
    '/install/Sh.Enigma.Shamir',
    '/install/shamir',
    '/install/sh.enigma.shamir/extra',
    '/install/sh..enigma',
    '/install/.sh.enigma',
    '/install/sh.enigma.%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    '/install/sh.enigma.shamir%00',
    '/install/sh.enigma.%E0%A4%A',            // broken percent encoding
    '/install/..%2F..%2Fetc%2Fpasswd',
    '/install/sh.enigma.sh%C3%A4mir',
    '/install/sh.enigma.shamir%0d%0aSet-Cookie:x=1',
    `/install/a.${'b'.repeat(99)}`,            // 101 characters
    '/install/sh.enigma.shamir;evil',
    '/',
    '/other',
  ];
  for (const path of bad) {
    const r = get(path);
    assert.equal(r.status, 404, path);
    const body = await r.text();
    assert.equal(body, 'Not found\n', path);
    assert.ok(!r.headers.get('set-cookie'), path);
  }
});

test('the longest valid id is accepted and one more is not', () => {
  assert.equal(appIdFromPath(`/install/a.${'b'.repeat(98)}`), `a.${'b'.repeat(98)}`);
  assert.equal(appIdFromPath(`/install/a.${'b'.repeat(99)}`), null);
});

test('the query string and fragment never reach the page or the link', async () => {
  const html = await get('/install/sh.enigma.shamir?registry=https://evil.example/&app=x&next=javascript:alert(1)').text();
  assert.ok(!html.includes('evil.example'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('registry='));
  assert.equal([...html.matchAll(/sanctum:\/\//g)].length, 1);
  assert.ok(html.includes('href="sanctum://install?app=sh.enigma.shamir"'));
});

test('the link is built from the validated id only, with nothing else in it', () => {
  assert.equal(installUrl('sh.enigma.shamir'), 'sanctum://install?app=sh.enigma.shamir');
});

test('only GET and HEAD are served', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = get('/install/sh.enigma.shamir', { method, body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? 'x' : undefined });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get('allow'), 'GET, HEAD');
  }
  const head = get('/install/sh.enigma.shamir', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('the stylesheet is served from the same origin and is only CSS', async () => {
  const r = get('/_/install.css');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/css/);
  const css = await r.text();
  assert.ok(!/@import|url\(/i.test(css), 'no external or embedded resources');
  const html = await get('/install/sh.enigma.shamir').text();
  assert.ok(html.includes('href="/_/install.css"'));
});

test('the module exports a fetch handler for Workers', async () => {
  const mod = await import('./index.mjs');
  const r = await mod.default.fetch(new Request('https://enigmahq.sh/install/sh.enigma.shamir'));
  assert.equal(r.status, 200);
});
