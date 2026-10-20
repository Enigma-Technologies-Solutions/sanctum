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
- **Off by default.** Sanctum itself still makes no network call. The `codex` process talks to
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
6. `chatgptDeviceCode` is the fallback when the browser callback cannot work (remote desktop, a
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
- `approvalPolicy: never` means a blocked action fails instead of asking to escalate. There is no
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

- Library header gets a "Create app" button (Lucide `plus` icon). It is
  hidden until Settings, Agent, "Enable Create app" is on.
- First use shows one panel: what Codex is, that prompts go to OpenAI, that Sanctum does not see the
  account token, "Sign in with ChatGPT", and a link to the privacy page.
- Chat view: transcript, composer, a "Codex is working" state with a stop button
  (`turn/interrupt`), the app card above the composer, session list reset on close.
- If `codex` is not found: explain, link to OpenAI's install page, offer a file picker.
- Settings, Agent: enable switch, account (plan, sign out), binary path, "Delete agent data".

## Finding the binary

GUI apps on macOS do not inherit the shell `PATH`. Look in this order: a path the user picked,
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, npm and cargo global bin directories, then
ask a login shell once (`$SHELL -lc 'command -v codex'`). Run `codex --version` and require a
minimum version recorded in code. Do not bundle Codex in this plan; revisit after Phase 3 (Apache-2.0
would allow it, but then Sanctum owns shipping its updates).

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

**Phase 0, spike (no merge, 1 to 2 days).** Throwaway Rust or Node script on the maintainer's
machine that: starts `codex app-server` with a dedicated `CODEX_HOME`, signs in with `chatgpt`,
runs one turn under the layer 1 policy, and captures the real traffic. Answers:

1. Exact method and field names (replace the names above if they differ).
2. Does the browser callback work with a dedicated `CODEX_HOME`, and what port does it bind?
3. Which hosts does the app-server contact (use a logging proxy)? Does anything beyond OpenAI appear?
4. Does `externalSandbox` let a Seatbelt-wrapped app-server run, on macOS?
5. Does a blocked write or network call fail cleanly under `approvalPolicy: never`?
6. How good is the HTML on a plain prompt, with and without our `AGENTS.md`?

Output: a short `docs/create-app-spike.md` with the findings. This is the go/no-go point.

**Phase 1, client.** `src-tauri/src/agent/`: process supervisor, JSON-RPC framing, typed messages
from the checked-in schema, a fake app-server used by tests. No UI.

**Phase 2, sign-in and chat.** Settings switch, sign-in panel, chat view, layer 1 policy, scratch
directory, binary discovery. Feature flag off by default.

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
- **Protocol drift.** The app-server surface changes between Codex releases. Mitigation: a pinned
  schema, a minimum version, one adapter module, and a clear "update Codex" message.
- **Quality.** Codex is a general coding agent; the prompt and `AGENTS.md` decide whether it produces
  clean single-file tools. Phase 0 measures this before any UI is built.
- **Plan limits.** ChatGPT plans have usage limits. Show the plan and a plain error when exhausted
  (`account/rateLimits/read` exists).
- **Seatbelt is deprecated by Apple** yet still the basis of both Codex's and Claude Code's macOS
  sandboxes. Accept, and track it.
- **Brand.** Do not use OpenAI or Codex names or logos as part of Sanctum's own naming. The button
  says "Create app"; text may say it uses Codex.

## Out of scope

API keys, other vendors, bundling a model or Codex, letting a generated tool call the agent at
runtime, background or scheduled generation, sharing generated tools to the registry (publishing
still goes through the signing flow).
