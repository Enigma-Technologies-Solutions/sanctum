// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Building apps with Codex, end to end: the real Sanctum (development build), its real Rust
// side and sandbox, and a fake Codex that follows a script. Run with:
//
//   pnpm test:e2e:build && pnpm test:e2e
//
// The manual steps these replace are in docs/create-app-plan.md ("Manual checklist").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { App, DATA } from './driver.mjs';

const ACCOUNT = 'e2e@example.com';
const MESSAGE = 'Message to Codex';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `body` with a fresh Sanctum, and always quits it. */
async function withApp(opts, body) {
  const app = await App.launch(opts);
  try {
    await body(app);
  } catch (e) {
    e.message += `\n--- Sanctum's output ---\n${app.log.join('').slice(-3000)}`;
    throw e;
  } finally {
    await app.quit();
  }
}

async function turnOnAndSignIn(app) {
  await app.click('main', 'Settings');
  await app.click('main', 'Turn on');
  await app.click('main', 'Sign in with ChatGPT');
  await app.see('main', ACCOUNT);
}

async function openCreate(app) {
  await app.click('main', 'Tool Vault');
  await app.click('main', 'Start building');
  await app.waitForWindow('create');
  await app.see('create', `Signed in as ${ACCOUNT}`);
}

async function send(app, text) {
  await app.type('create', MESSAGE, text);
  await app.click('create', 'Send');
}

/** Waits for the turn to end: the Send button is back. */
async function turnDone(app) {
  await app.waitFor('create', `return !button('Stop') && !!field(${JSON.stringify(MESSAGE)})`, { what: 'turn to end' });
}

async function alertText(app, window) {
  return app.waitFor(window, `const a = $all('[role=alert]').filter(visible).map(textOf).join(' | '); return a || null;`, { what: 'an error' });
}

test('building apps is off until turned on, and nothing starts', async () => {
  await withApp({}, async (app) => {
    assert.equal(await app.hasButton('main', 'Start building'), false);
    await app.click('main', 'Settings');
    await app.waitFor('main', `return !!button('Turn on')`, { what: 'Turn on' });
    assert.equal(await app.hasButton('main', 'Sign in with ChatGPT'), false);
    assert.deepEqual(await app.windows(), ['main']);
    assert.deepEqual(app.fakeLog(), []);
    assert.deepEqual(await app.browser(), []);
  });
});

test('sign in opens only the OpenAI sign-in page, and sign out and in again works', async () => {
  await withApp({}, async (app) => {
    await turnOnAndSignIn(app);
    const urls = await app.browser();
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]).host, 'auth.openai.com');

    await app.click('main', 'Sign out');
    await app.waitFor('main', `return !!button('Sign in with ChatGPT') && !bodyText().includes(${JSON.stringify(ACCOUNT)})`, { what: 'signed out' });
    await app.click('main', 'Sign in with ChatGPT');
    await app.see('main', ACCOUNT);
  });
});

test('a sign-in OpenAI refuses shows an error and stays signed out', async () => {
  await withApp({ scenario: { login: 'fail' } }, async (app) => {
    await app.click('main', 'Settings');
    await app.click('main', 'Turn on');
    await app.click('main', 'Sign in with ChatGPT');
    // The fake's own refusal, not some other failure such as Codex not starting.
    const err = await alertText(app, 'main');
    assert.match(err, /sign-in failed: denied/);
    assert.equal(await app.hasButton('main', 'Sign in with ChatGPT'), true);
  });
});

test('build, preview, version history, add to library, then modify with Codex', async () => {
  await withApp({ scenario: { turns: [{ do: 'build', title: 'Counter' }, { do: 'build', title: 'Counter' }] } }, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);

    await send(app, 'A counter with a plus button');
    await app.see('create', 'It does not ask for the network, your devices or storage.');
    await app.see('create', 'Counter');

    // Preview opens a draft window of its own.
    await app.click('create', 'Preview');
    await app.waitFor('create', 'return true');
    const wins = await app.windows();
    assert.ok(wins.some((w) => w.startsWith('tool-draft-')), `no preview window in ${wins}`);

    // A second turn makes a second draft; the first one can be brought back.
    await send(app, 'Make the button bigger');
    await turnDone(app);
    await app.waitFor('create', `return !!button('Go back to Draft 1')`, { what: 'draft history' });
    await app.click('create', 'Go back to Draft 1');
    await app.waitFor('create', `return !button('Go back to Draft 1') && !!button('Go back to Draft 2')`, { what: 'draft 1 restored' });

    await app.click('create', 'Add to library');
    await app.see('create', 'Added to your library as "Counter"');

    // The main window lists it, marked as made with Codex.
    await app.click('main', 'Tool Vault');
    await app.waitFor('main', `return !!$all('[aria-label^="Made with Codex"]').length`, { what: 'Made with Codex badge' });

    // Modify with Codex reopens the Create window about that tool.
    await app.click('main', 'Inspect');
    await app.click('main', 'Update');
    await app.click('main', 'Modify with Codex');
    // A conversation is open, so the Create window asks first.
    await app.click('create', 'Change it instead');
    await app.waitFor('create', `return !!document.querySelector('[data-testid=source-app]')`, { what: 'the app as a source' });
    assert.equal(app.fakeLog().length, 2);
  });
});

test('Codex stopping in the middle of a turn is reported, and the next message works', async () => {
  await withApp({ scenario: { turns: [{ do: 'hang' }, { do: 'build' }] } }, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);
    await send(app, 'A markdown editor');
    await app.waitFor('create', `return !!button('Stop')`, { what: 'turn running' });
    await sleep(500);
    app.killCodex();
    const err = await alertText(app, 'create');
    assert.ok(err.length > 0);
    // The session ended with the process; the window offers a new one.
    await app.click('create', 'Start a new session');
    await app.see('create', `Signed in as ${ACCOUNT}`);
    await send(app, 'Try again');
    await app.see('create', 'It does not ask for the network');
  });
});

test('a turn that fails, as when offline, shows the error and the next message works', async () => {
  const offline = 'stream disconnected before completion: error sending request';
  await withApp({ scenario: { turns: [{ do: 'fail', error: offline }, { do: 'build' }] } }, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);
    await send(app, 'Hello');
    const err = await alertText(app, 'create');
    assert.ok(err.length > 0);
    await turnDone(app);
    await send(app, 'Hello again');
    await app.see('create', 'It does not ask for the network');
  });
});

test('Stop ends a turn that does not finish', async () => {
  await withApp({ scenario: { turns: [{ do: 'hang' }, { do: 'build' }] } }, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);
    await send(app, 'Something slow');
    await app.click('create', 'Stop');
    await turnDone(app);
    await send(app, 'Something quick');
    await app.see('create', 'It does not ask for the network');
  });
});

test('Stop pressed while the turn is still starting ends it', async () => {
  await withApp({ scenario: { turns: [{ do: 'hang', startDelay: 1500 }, { do: 'build' }] } }, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);
    await send(app, 'Something slow to start');
    await app.click('create', 'Stop');
    await turnDone(app);
    await send(app, 'Something quick');
    await app.see('create', 'It does not ask for the network');
  });
});

test('turning it off ends the session, says so in the Create window and keeps the sign-in', async () => {
  await withApp({}, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);
    await app.click('main', 'Settings');
    await app.click('main', 'Turn off');
    await app.see('create', 'Building apps is turned off.');
    await app.click('main', 'Tool Vault');
    await sleep(300);
    assert.equal(await app.hasButton('main', 'Start building'), false);

    await app.click('main', 'Settings');
    await app.click('main', 'Turn on');
    await app.see('main', ACCOUNT);
  });
});

test('Delete agent data removes every file, turns it off and keeps the library', async () => {
  await withApp({}, async (app) => {
    await turnOnAndSignIn(app);
    await openCreate(app);
    await send(app, 'A counter');
    await app.click('create', 'Add to library');
    await app.see('create', 'Added to your library');

    const agent = join(DATA, 'agent');
    assert.ok(existsSync(join(agent, 'codex-home/fake-auth')));

    await app.click('main', 'Settings');
    await app.click('main', 'Delete agent data');
    await app.click('main', 'Cancel');
    assert.ok(existsSync(join(agent, 'codex-home/fake-auth')), 'Cancel deleted something');

    await app.click('main', 'Delete agent data');
    await app.click('main', 'Delete');
    await app.waitFor('main', `return !!button('Turn on')`, { what: 'turned off' });
    await app.see('create', 'Building apps is turned off.');
    assert.equal(existsSync(agent), false, 'agent folder still there');

    await app.click('main', 'Tool Vault');
    await app.waitFor('main', `return !!button('Inspect')`, { what: 'the tool still in the library' });
  });
});
