// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Starts the development build of Sanctum with the end-to-end remote control on
// (src-tauri/src/e2e.rs) and the fake Codex (e2e/fake-codex.py), and drives its windows.
// The build uses its own identifier (src-tauri/tauri.e2e.conf.json), so its data folder is
// separate from an installed Sanctum's and is wiped before every launch.

import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BINARY = join(ROOT, 'src-tauri/target/debug/sanctum');
export const DATA = join(homedir(), 'Library/Application Support/sh.enigma.sanctum.e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helpers available to every script run in a page.
const PRELUDE = `
const $all = (sel) => [...document.querySelectorAll(sel)];
const visible = (el) => !!el && el.getClientRects().length > 0;
const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
const named = (el) => el.getAttribute('aria-label') || textOf(el);
const button = (name) => $all('button, [role=button], a').filter(visible)
  .find((b) => named(b) === name || textOf(b) === name);
const field = (label) => $all('textarea, input').find((f) => f.getAttribute('aria-label') === label
  || f.getAttribute('placeholder') === label);
const setValue = (el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const bodyText = () => textOf(document.body);
`;

class Socket {
  constructor(path) {
    this.path = path;
    this.next = 1;
    this.waiting = new Map();
    this.buf = '';
  }
  async connect(timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        this.conn = await new Promise((res, rej) => {
          const c = createConnection(this.path, () => res(c));
          c.once('error', rej);
        });
        break;
      } catch (e) {
        if (Date.now() > end) throw new Error(`no control socket at ${this.path}: ${e.message}`);
        await sleep(200);
      }
    }
    this.conn.setEncoding('utf8');
    this.conn.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
      }
    });
  }
  request(req) {
    const id = this.next++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.conn.write(JSON.stringify({ ...req, id }) + '\n');
    });
  }
  close() {
    this.conn?.destroy();
  }
}

export class App {
  /** Starts Sanctum with a fresh data folder. `scenario` is what the fake Codex does. */
  static async launch({ scenario = {}, outerSandbox = true } = {}) {
    if (!existsSync(BINARY)) throw new Error(`build it first: pnpm test:e2e:build (${BINARY} missing)`);
    rmSync(DATA, { recursive: true, force: true });
    const work = mkdtempSync(join(tmpdir(), 'sanctum-e2e-'));
    const fake = join(work, 'codex', 'codex');
    execFileSync('mkdir', ['-p', dirname(fake)]);
    copyFileSync(join(ROOT, 'e2e/fake-codex.py'), fake);
    chmodSync(fake, 0o755);
    const app = new App(work, fake);
    app.setScenario(scenario);
    const env = {
      ...process.env,
      SANCTUM_E2E_SOCKET: join(work, 'control.sock'),
      SANCTUM_CODEX_BIN: fake,
      SANCTUM_OUTER_SANDBOX: outerSandbox ? '1' : '0',
    };
    app.proc = spawn(BINARY, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.proc.stdout.on('data', (d) => app.log.push(String(d)));
    app.proc.stderr.on('data', (d) => app.log.push(String(d)));
    app.socket = new Socket(env.SANCTUM_E2E_SOCKET);
    await app.socket.connect();
    await app.waitFor('main', 'return document.readyState === "complete" && bodyText().length > 0');
    return app;
  }

  constructor(work, fake) {
    this.work = work;
    this.fake = fake;
    this.log = [];
  }

  setScenario(s) {
    writeFileSync(join(dirname(this.fake), 'scenario.json'), JSON.stringify(s));
  }

  /** The turns the fake Codex has run, one line each. */
  fakeLog() {
    const f = join(DATA, 'agent/codex-home/fake-log');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
  }

  async eval(window, js) {
    const r = await this.socket.request({ op: 'eval', window, js: PRELUDE + js });
    if (r.error) throw new Error(`[${window}] ${r.error}`);
    return r.ok;
  }

  async windows() {
    return (await this.socket.request({ op: 'windows' })).ok;
  }

  /** Addresses sign-in would have opened in the browser. */
  async browser() {
    return (await this.socket.request({ op: 'browser' })).ok;
  }

  /** Runs `js` until it returns something truthy, and returns that. */
  async waitFor(window, js, { timeout = 15000, what = js } = {}) {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        const v = await this.eval(window, js);
        if (v) return v;
      } catch (e) {
        last = e;
      }
      if (Date.now() > end) {
        let text = '';
        try {
          text = await this.eval(window, 'return bodyText()');
        } catch {}
        throw new Error(`timed out waiting in ${window} for: ${what}\n${last ? `last error: ${last.message}\n` : ''}page: ${text.slice(0, 1500)}`);
      }
      await sleep(150);
    }
  }

  async waitForWindow(label, { gone = false, timeout = 15000 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const has = (await this.windows()).includes(label);
      if (has !== gone) return;
      if (Date.now() > end) throw new Error(`window ${label} ${gone ? 'still open' : 'never opened'}`);
      await sleep(150);
    }
  }

  /** Clicks the visible button whose text or label is exactly `name`, waiting for it. */
  async click(window, name, opts) {
    const n = JSON.stringify(name);
    await this.waitFor(window, `const b = button(${n}); return !!b && !b.disabled;`, { what: `button ${name}`, ...opts });
    await this.eval(window, `button(${n}).click(); return true;`);
  }

  async hasButton(window, name) {
    return this.eval(window, `return !!button(${JSON.stringify(name)})`);
  }

  async type(window, label, text) {
    const l = JSON.stringify(label);
    await this.waitFor(window, `return !!field(${l})`, { what: `field ${label}` });
    await this.eval(window, `setValue(field(${l}), ${JSON.stringify(text)}); return true;`);
  }

  /** Waits for `text` to appear in the window. */
  async see(window, text, opts) {
    const t = JSON.stringify(text);
    return this.waitFor(window, `return bodyText().includes(${t})`, { what: `text ${text}`, ...opts });
  }

  async text(window) {
    return this.eval(window, 'return bodyText()');
  }

  /** Stops the fake Codex the hard way, as if it crashed. */
  killCodex() {
    try {
      execFileSync('pkill', ['-9', '-f', this.fake]);
    } catch {}
  }

  async quit() {
    this.socket?.close();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      await Promise.race([new Promise((r) => this.proc.once('exit', r)), sleep(5000)]);
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    this.killCodex();
    rmSync(this.work, { recursive: true, force: true });
  }
}
