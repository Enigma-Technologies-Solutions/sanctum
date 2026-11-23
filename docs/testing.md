# Testing

Sanctum has four kinds of test. The first two run in CI on every pull request. The live tests
need a ChatGPT account and run by hand before a release and whenever the Codex pin changes. A
short manual pass covers what cannot be automated.

| Kind | Command | Where | What it proves |
|---|---|---|---|
| Unit, Rust | `cargo test --manifest-path src-tauri/Cargo.toml` | CI (Linux) | Parsing, policy, the sandbox profile text, the protocol with a scripted fake |
| Unit, interface | `pnpm test` | CI (Linux) | Components and copy, with Sanctum's commands mocked |
| End to end | `pnpm test:e2e:build && pnpm test:e2e` | CI (macOS), or locally | The real app, its Rust side and its sandbox, driven through its windows, with a fake Codex |
| Live | `scripts/test-live.sh` | By hand, macOS | The pinned Codex, signed in, under the sandbox |

## End to end

`pnpm test:e2e:build` makes a development build with its own identifier
(`sh.enigma.sanctum.e2e`, from `src-tauri/tauri.e2e.conf.json`). Its data folder,
`~/Library/Application Support/sh.enigma.sanctum.e2e`, is separate from an installed Sanctum's
and is wiped before each test. An installed Sanctum can stay open while the tests run.

Each test starts that build with two variables:

- `SANCTUM_E2E_SOCKET` turns on a remote control (`src-tauri/src/e2e.rs`). The test sends
  JavaScript to the main or Create window over a Unix socket and gets the result back. While it
  is on, sign-in records the address it would open instead of opening the browser.
- `SANCTUM_CODEX_BIN` points at `e2e/fake-codex.py`, a stand-in for `codex app-server` that does
  what `scenario.json` beside it says: build a draft, fail, hang, or exit in the middle of a turn.

Both variables are read only by development builds. A release build compiles neither, and CI
fails if a release program contains the remote control's variable name.

The fake runs under Sanctum's real sandbox, like the real Codex, so the tests also cover
starting the proxy and the profile. `SANCTUM_OUTER_SANDBOX=0` is not used.

The tests are in `e2e/create.test.mjs` and the helpers in `e2e/driver.mjs`. Helpers find
buttons by their visible name or `aria-label`, as a person or a screen reader would, so a test
breaks when a label changes. That is intended: labels are part of what is tested.

To add a test, start the app with the scenario it needs, then click, type and wait:

```js
await withApp({ scenario: { turns: [{ do: 'build', title: 'Timer' }] } }, async (app) => {
  await turnOnAndSignIn(app);
  await openCreate(app);
  await send(app, 'A timer');
  await app.see('create', 'It does not ask for the network');
});
```

## Live

```bash
scripts/test-live.sh --sign-in   # once: signs ~/.sanctum-test/codex-home in to ChatGPT
scripts/test-live.sh             # live_layer_2, live_account, live_create, and two registry checks
```

Use an account you are willing to spend a few turns of usage on. The sign-in is kept apart from
the one Sanctum and Codex use day to day: ChatGPT retires an old sign-in when Codex renews it, so
the tests copy the test sign-in, write the renewed one back, and never sign it out.

The Codex program is the one Sanctum downloaded for the pinned version
(`src-tauri/src/agent/codex-pins.json`), checked against the pin by the script. The model's
replies vary, so the live tests check outcomes (a draft that scans clean, a turn that ends,
nothing from the network), never wording.

## By hand, before a release

About five minutes, on the release build of the version being tagged:

1. Sign in to ChatGPT in the browser, from Settings, and sign out again.
2. Build one small app and open it from the library.
3. VoiceOver on the Create window and the Settings rows for building apps.
4. On Linux and Windows, Settings says building apps is not available, and nothing downloads.
