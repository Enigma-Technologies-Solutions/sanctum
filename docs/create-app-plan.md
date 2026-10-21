<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Enigma Technologies Solutions
-->

# Create app with Codex: plan

Status: proposal, nothing built. Written 2026-10-20.

Goal: a "Create app" button in Sanctum opens a chat. The user signs in once with their ChatGPT
account (no API key), describes a tool, and Codex writes one HTML file that Sanctum scans and runs
under its normal rules. No copy and paste.

## Decisions

- **Codex only, ChatGPT sign-in only.** No API keys, no Claude. Claude has no sanctioned chat
  protocol on a subscription login, and its terms forbid third-party apps from offering Claude.ai
  login ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- **Drive the real `codex app-server`.** It is OpenAI's documented JSON-RPC 2.0 protocol for rich
  clients ([docs](https://learn.chatgpt.com/docs/app-server)). Sanctum starts the user's unmodified
  `codex` binary over stdio and renders the chat itself. Codex owns the OAuth flow, stores and
  refreshes the tokens. **Sanctum never reads, copies or logs a token.**
- **Everything happens inside the Sanctum window.** The user never runs a command or a script. The
  Welcome panel (and the empty Tool Vault) offers "Sign in with ChatGPT to build your own app".
  The click opens the browser, the user signs in on OpenAI's page, and the app takes it from there.
- **Sanctum is the only thing a person installs.** Customers are not developers and will not have
  `codex`. The first time they click Sign in, Sanctum downloads the pinned, unmodified Codex release
  and checks it (see "Getting Codex").
- **Off until chosen.** Sanctum itself still makes no network call. The `codex` process talks to
  OpenAI, only after the user turns the feature on, signs in and sends a prompt.
- **Generated tools are ordinary unsigned tools.** Same scan, same hidden-character and size checks,
  no approvals at install, origin shown as "Created in Sanctum with Codex". The agent never receives
  a Sanctum capability and never touches the tool vault.

## How sign-in works

Methods, as documented (names to be confirmed against the generated schema in Phase 0):

1. `initialize`, then the `initialized` notification.
2. `account/read` tells us whether an account is already active (`account/updated` carries
   `authMode` and `planType`).
3. `account/login/start` with type `chatgpt`. The response holds a login id and an auth URL. Sanctum
   opens the URL in the default browser. The user signs in on OpenAI's page.
4. `account/login/completed` arrives with `{ loginId, success, error? }`. Sanctum shows the plan name.
5. `account/logout` signs out. `account/login/cancel` aborts a pending login.
6. Never use `chatgptAuthTokens`. The schema marks it "FOR OPENAI INTERNAL USE ONLY - DO NOT USE",
   and it would make Sanctum the holder of the token.
7. `chatgptDeviceCode` is the fallback when the browser callback cannot work (remote desktop, a
   locked-down machine). It shows a code to type on another device.

Codex persists credentials itself. We give it a **dedicated `CODEX_HOME`** under Sanctum's app data
directory (`<app data>/agent/codex-home`). Consequences:

- The user signs in once more, for Sanctum only. The cost is one click.
- The agent cannot see the user's other Codex config, history, `AGENTS.md` or credentials.
- Sanctum writes the `config.toml` there, so the sandbox and model settings are ours, not whatever
  the user has globally.
- Sign out in Sanctum deletes that directory.

## Where Codex runs, and how it is contained

Codex is a child process of the Sanctum Rust core, started with `tokio::process::Command`, stdio
piped, `kill_on_drop`, one process per Create session, killed when the session closes or Sanctum
quits. We do not ship a container runtime: Docker and Podman need an installed daemon, and a bundled
VM would break the "one desktop app" promise. Containment is OS-level and in two layers.

**Layer 1 (Phase 2): Codex's own sandbox, set by Sanctum on every turn.**

```json
{ "approvalPolicy": "never",
  "sandboxPolicy": { "type": "workspaceWrite",
                     "writableRoots": ["<session scratch dir>"],
                     "networkAccess": false } }
```

- Seatbelt on macOS, Landlock plus seccomp on Linux, a restricted token on Windows.
- `networkAccess: false` applies to commands the agent runs. It does not block the model
  connection, which belongs to the app-server process.
- `approvalPolicy: "never"` (the schema's values are `untrusted`, `on-failure`, `on-request`,
  `never`) means a blocked action fails instead of asking to escalate. There is no
  prompt for the user to click through, and nothing for an injected instruction to talk them into.
- The scratch directory is new per session and holds `app.html`, plus an `AGENTS.md` written by
  Sanctum (see "What the agent is told").

**Known gap in layer 1:** workspace-write still lets commands read most of the disk. With network
off for commands, the only path out is the model conversation, and the only input is the user's own
prompt, so the exposure is small but real. Layer 2 closes it.

**Layer 2 (Phase 5, hardening): Sanctum's own sandbox around the whole app-server process.**

- macOS `sandbox-exec` profile (deny default); Linux bubblewrap or Landlock. Reads allowed only for
  system libraries, the Codex binary, `CODEX_HOME` and the scratch directory. Writes allowed only
  for `CODEX_HOME` and scratch.
- Network allowed only to localhost, where a small Sanctum proxy forwards CONNECT requests to an
  allowlist of OpenAI hosts. The hosts are measured in Phase 0, never guessed. Seatbelt cannot
  filter by domain, which is why the proxy is needed.
- **Nesting problem:** an already sandboxed process cannot start Seatbelt itself. The protocol has a
  policy type `externalSandbox` for exactly this, and Phase 0 must prove it works on macOS before
  Layer 2 is committed to.
- Windows has no equivalent. Windows stays on layer 1 only, or the feature is hidden there until
  WSL2 is an option. Say so in the UI.

What neither layer stops: hostile HTML in the output. That is handled by Sanctum's existing model,
not by trusting the agent: the file is scanned, starts with no approvals, runs in its own origin.

## What the agent is told

Sanctum writes `AGENTS.md` into the scratch directory on every session, built from
`SANCTUM_FOR_AGENTS.md` (which already describes what a Sanctum tool may use) plus fixed rules:

- Produce exactly one self-contained file, `app.html`. No build step, no CDN, no remote fonts or
  scripts, no network calls unless the user asks for a specific host.
- Use only the Sanctum APIs the user's request needs, so the scanner's findings stay minimal.
- Do not touch anything outside the scratch directory.

This is guidance for quality, not a security control. The controls are the sandbox and the scan.

## From chat to tool

1. The user sends a prompt. Sanctum calls `thread/start` (once) and `turn/start` with the policy
   above. Streamed `item/agentMessage/delta` notifications render as chat text through the existing
   Markdown renderer (parsed to data, rendered as React elements, links copy-only).
2. When `turn/completed` arrives, Sanctum looks for `app.html` in the scratch directory. If it
   exists and passed the size cap (start at 2 MB), Sanctum runs the existing scan and shows a card:
   name, description, detected capabilities, a "Preview" button.
3. "Preview" opens the draft in a tool window with **no approvals**, labelled as a draft.
4. "Add to library" calls the existing ingest path with origin `agent`. A later turn that changes
   `app.html` offers "Save as new version", which reuses the existing versioning and rollback.
5. Closing the session deletes the scratch directory. Nothing outside the library persists.

Capability approval is unchanged. A generated tool that wants Storage or a network host shows the
same approval screen as any other tool, and the user decides.

## UI

- **Entry points:** the Welcome panel gets a second action, "Sign in with ChatGPT to build your own
  app" (Lucide `log-in` icon), beside "Browse signed tools". Once signed in, the same place and the
  Tool Vault header show "Create app" (Lucide `plus`). The empty-state text mentions it.
- First use shows one panel: what Codex is, that prompts go to OpenAI, that Sanctum does not see the
  account token, "Sign in with ChatGPT", and a link to the privacy page.
- Chat view: transcript, composer, a "Codex is working" state with a stop button
  (`turn/interrupt`), the app card above the composer, session list reset on close.
- If Codex fails to download or start: show the error text and a "Copy details" button. No install
  instructions, because nothing is expected to be installed.
- Settings, Agent: account (plan, sign out), Codex version, advanced binary path, "Delete agent data".
- Offline or sign-in failure: plain message, the rest of Sanctum is unaffected.

## Getting Codex

**Download it on first use.** Codex is about 100 MB to download and 250 to 340 MB on disk, which is
ten times the Sanctum installer, so it is not bundled. The first time someone clicks "Sign in with
ChatGPT", Sanctum downloads the exact release pinned in `src-tauri/src/agent/codex-pins.json` from
OpenAI's GitHub releases. The screen says so, with the size, before the click.

- `scripts/pin-codex.py <version>` writes the pins: for each platform, the release URL, the size and
  SHA-256 of the archive (checked against the digest GitHub publishes) and of the one program inside.
  Review the diff like code. A new Codex version is a Sanctum release, and
  `spec/codex-app-server/` is regenerated from the same version; a test fails if they differ.
- Download rules (`agent/install.rs`): github.com only, redirects only to github.com or
  githubusercontent.com over https, exactly the pinned size and hash, a stall and a total timeout, and
  cancel at any moment. Exactly one file is taken out of the archive, chosen by name from the pin;
  the archive decides no paths. The program must match its own pinned hash, and is hashed again
  before every start, so a changed file is never run.
- It is saved under `<app data>/agent/bin/<version>/`. An older version is deleted after a new one
  installs. Nothing is downloaded until the click, so Sanctum stays network-silent otherwise.
- Codex is Apache-2.0, so redistribution is allowed. Still to do: ship its LICENSE and NOTICE in the
  app's licences page.
- The Codex name and logo are not used as Sanctum's own naming (see Risks).
- A development build can use its own copy through `SANCTUM_CODEX_BIN`; release builds ignore it.
- Platforms: macOS (both chips), Linux (x86_64 and arm64, static musl builds), Windows x86_64.
  Elsewhere the Welcome button is hidden and Settings says it is not available yet.
- Still to measure: whether macOS Gatekeeper accepts the downloaded program (it is fetched by
  Sanctum, so it carries no quarantine flag, but check on a clean Mac), Windows SmartScreen, and
  how Codex finds `bwrap` on Linux (needed for Phase 5).

## Hardening rules for the client

- JSON lines capped at 8 MB, stderr kept to a bounded ring buffer, per-turn timeout (10 minutes) and
  a maximum item count, then kill the process.
- Unknown methods and notifications are ignored, never executed. Server-initiated requests
  (`item/permissions/requestApproval` and similar) are **denied** by default, because the policy is
  `never` and Create app has no use for them.
- Notification bodies are not logged. The auth URL is opened and discarded.
- All text from the agent goes through `cleanText` (hidden and bidi characters) before display.
- Commands for this feature are registered on the `main` window capability only. Tool windows keep
  zero IPC.
- The protocol schema is generated with `codex app-server generate-json-schema` and checked in under
  `spec/codex-app-server/`, with the Codex version it came from. CI parses recorded fixtures against it.

## Phases (one small PR each, as before)

**Phase 0, no separate spike.** The first slice is built in the app, because the goal is the
in-app experience and a throwaway script would prove less. Already settled from the schema generated
by Codex 0.137.0 (`codex app-server generate-json-schema`): the method names above exist, including
`externalSandbox`; approval values are as listed. Still to learn, with a developer-only trace in
Phase 1 (off in release builds, tokens redacted): the exact login callback behaviour with a dedicated
`CODEX_HOME`, which hosts the process contacts, whether `externalSandbox` lets a wrapped process run,
how a blocked action fails, and how good the HTML is. Phase 5 does not start until the last two are
answered.

**Phase 1, client and sign-in.** `src-tauri/src/agent/`: process supervisor, JSON-RPC framing, typed
messages from the checked-in schema, a fake app-server for tests, and the sign-in commands
(`agent_status`, `agent_sign_in`, `agent_sign_out`). UI: the Welcome panel button and a Settings,
Agent card showing signed-in state and plan. This slice already works end to end with a real login.

Status: the client merged in #33. The commands are `agent_setup`, `agent_account`, `agent_sign_in`,
`agent_cancel_sign_in` and `agent_sign_out`, all main-window only. Sign-in downloads Codex the first
time (progress arrives as `agent-download` events), starts it, opens the browser and waits. Looking
at the setup reads files only. The Codex process starts when the person clicks Sign in, or opens
Settings with Codex already downloaded, never at launch, and stops when Sanctum quits. Checked against
the real Codex 0.163.0 for the handshake, `account/read`, `account/login/start` and cancel; a full
sign-in has not been tried yet. Its browser callback listens on a fixed local port (1455), so a
second Codex signing in at the same time would collide.

**Phase 2, chat.** Chat view, layer 1 policy, scratch directory, "Create app" button in the Tool
Vault header and empty state. Release builds keep the feature behind a switch until Phase 4.

**Phase 3, from chat to library.** Scan card, preview, add to library, new versions, origin badge,
cleanup of scratch directories.

**Phase 4, copy and docs.** Privacy statement rewritten before the feature is announced: Sanctum
makes no network calls itself; with Create app on, the Codex process sends prompts to OpenAI. Update
README, site, `SECURITY.md`, the in-app welcome copy and the security notes. No release until this
lands (the privacy copy is a promise, see the Phase 8 decision in [launch.md](launch.md)).

**Phase 5, layer 2.** macOS first, then Linux. Local allowlist proxy, Seatbelt or bubblewrap
profile, `externalSandbox`. Windows decision recorded.

**Phase 6, review.** Security review note in the style of `security-review-0.2.0.md`, a dependency
audit, a manual checklist (sign in, sign out, kill the process mid-turn, offline, no `codex`, an
old `codex`, prompt asking the agent to read `~/.ssh` and to call `curl`), then a release.

## Tests

- Rust unit tests with a scripted fake app-server: handshake, login success and failure, streaming,
  oversize lines, hung process, unexpected server requests.
- UI tests for the sign-in states, the chat, and the app card, with `Commands` mocked.
- Mutation checks on the policy builder (each of sandbox type, network flag, approval policy, writable
  root must be asserted) and on the denial of server-initiated requests.
- Manual, real Codex: the checklist above. Record the Codex version tested.

## Risks and open questions

- **Terms.** OpenAI documents the protocol for rich clients, but I found no statement that a
  third-party app may use ChatGPT-plan sign-in through it. Ask OpenAI before Phase 2 ships. If the
  answer is no, the only compliant fallback is an API key, which we chose to avoid. Do not release
  without the answer.
- **Protocol drift.** The app-server surface changes between Codex releases. Because Sanctum pins
  the exact binary, the pinned schema and the binary always move together, and CI parses fixtures against it.
- **Quality.** Codex is a general coding agent; the prompt and `AGENTS.md` decide whether it produces
  clean single-file tools. Phase 0 measures this before any UI is built.
- **Plan limits.** ChatGPT plans have usage limits. Show the plan and a plain error when exhausted
  (`account/rateLimits/read` exists).
- **Seatbelt is deprecated by Apple** yet still the basis of both Codex's and Claude Code's macOS
  sandboxes. Accept, and track it.
- **Brand.** Do not use OpenAI or Codex names or logos as part of Sanctum's own naming. Bundling also means
  Sanctum redistributes OpenAI software; include it in the Phase 6 review and in the question to OpenAI. The button
  says "Create app"; text may say it uses Codex.

## Out of scope

API keys, other vendors, bundling a model, letting a generated tool call the agent at
runtime, background or scheduled generation, sharing generated tools to the registry (publishing
still goes through the signing flow).
