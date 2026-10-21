// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Create app: a client for the Codex app-server (docs/create-app-plan.md).
//!
//! Layers, bottom to top:
//!
//! - [`rpc`]: newline-delimited JSON-RPC with size limits, over any pair of streams.
//! - [`protocol`]: the few methods and shapes Sanctum uses, checked against the schema that
//!   ships in `spec/codex-app-server/`.
//! - [`account`]: account state and the ChatGPT browser sign-in.
//! - [`process`]: starting the `codex` binary with a cleared environment and its own home.
//! - [`install`]: downloading the pinned Codex release on first use and checking it.
//! - [`commands`]: the Tauri commands the main window calls.
//!
//! Rules this module must keep:
//!
//! 1. **Sanctum never reads, stores, logs or forwards a token.** Codex owns the sign-in and
//!    keeps the credentials in its own `CODEX_HOME`. The `chatgptAuthTokens` mode, which would
//!    hand the token to us, is unreachable by construction (see `protocol`).
//! 2. **Nothing here runs unless the person asked.** No agent process starts at launch, and no
//!    request is made in the background. The privacy copy says Sanctum makes no request by
//!    itself except the update check; keep that true, or change the copy first.
//! 3. **Every request from the agent is refused.** Approvals and tool calls have no handler.
//! 4. **Nothing from the agent is trusted as text.** Anything shown to the person passes the
//!    same hidden-character cleaning as registry text, at the Commands boundary.

pub mod account;
pub mod commands;
pub mod install;
pub mod process;
pub mod protocol;
pub mod rpc;

#[derive(Debug)]
pub enum AgentError {
    Rpc(rpc::RpcError),
    /// An answer that does not match the protocol we understand.
    Protocol(String),
    /// The address Codex asked us to open is not a plain HTTPS address.
    BadAuthUrl,
    /// The browser could not be opened.
    Browser(String),
    /// Codex reported that the sign-in did not complete.
    LoginFailed(String),
    /// The person did not finish signing in in time.
    LoginTimeout,
    /// The process could not be started.
    Spawn(String),
}

impl From<rpc::RpcError> for AgentError {
    fn from(e: rpc::RpcError) -> Self {
        AgentError::Rpc(e)
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::Rpc(e) => write!(f, "{e}"),
            AgentError::Protocol(m) => write!(f, "{m}"),
            AgentError::BadAuthUrl => write!(
                f,
                "the sign-in address was not a safe web address, so it was not opened"
            ),
            AgentError::Browser(m) => write!(f, "could not open the browser: {m}"),
            AgentError::LoginFailed(m) => write!(f, "sign-in failed: {m}"),
            AgentError::LoginTimeout => write!(f, "sign-in was not finished in time"),
            AgentError::Spawn(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for AgentError {}
