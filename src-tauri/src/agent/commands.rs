// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Tauri commands for the agent: is it set up, who is signed in, sign in, cancel, sign out.
//!
//! Every command runs only when the person clicks something in Sanctum's own windows (the main
//! window, or the Create window it opens). Codex is
//! downloaded (see [`super::install`]) only when they choose to sign in, and the `codex`
//! process starts on the first command that needs it, never at launch. It stops when Sanctum
//! quits. Tool windows have no IPC; each command also checks the window label.
//!
//! Text that came from the agent (an error message, an email address) is cleaned again in
//! `src/lib/commands.ts` before it is shown.

use super::account::{self, Status, SIGN_IN_TIMEOUT};
use super::chat::{self, Limits, TurnOutcome, Update};
use super::draft;
use super::history::{self, History};
use super::install::{self, InstallError, Release};
use super::process::AgentProcess;
use super::AgentError;
use crate::registry::fetch::Transport;
use serde::Serialize;
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};
use tokio::sync::Mutex;

/// Label of the window where the chat lives, so it stays open while you use the rest of Sanctum.
pub const CREATE_WINDOW: &str = "create";

/// Event the window that clicked Sign in listens for while Codex downloads.
pub const DOWNLOAD_EVENT: &str = "agent-download";
/// Event carrying the agent's reply while a turn runs.
pub const CHAT_EVENT: &str = "agent-chat";
/// Event carrying each step the agent takes (a command, a file written, a thought).
pub const ACTIVITY_EVENT: &str = "agent-activity";

/// The managed state. Holds at most one running agent process.
pub struct AgentState {
    home: PathBuf,
    bin_dir: PathBuf,
    version: String,
    /// `None` on a computer Sanctum has no Codex build for.
    release: Option<Release>,
    transport: Result<Arc<dyn Transport>, String>,
    /// A program to use instead of the download. Debug builds only; see [`debug_override`].
    program_override: Option<PathBuf>,
    sessions_dir: PathBuf,
    /// Copies of drafts that are open in preview windows.
    previews_dir: PathBuf,
    previews_cleaned: AtomicBool,
    /// The person's standing instructions for every app, a plain text file.
    instructions_path: PathBuf,
    /// The marker file that says the person turned building apps on. Absent means off.
    enabled_path: PathBuf,
    enabled: AtomicBool,
    process: Mutex<Option<Arc<AgentProcess>>>,
    signing_in: AtomicBool,
    cancelled: AtomicBool,
    /// The one open build session, if any.
    chat: Mutex<Option<Arc<ChatSession>>>,
    turn_running: AtomicBool,
    /// The running turn's id, so a stop request can interrupt it.
    turn_slot: StdMutex<Option<String>>,
}

/// An open build session: one Codex thread and its scratch folder.
struct ChatSession {
    thread_id: String,
    scratch: PathBuf,
    /// The library tool this session added, so a later draft becomes a new version of it.
    tool_id: StdMutex<Option<String>>,
    /// Every distinct `app.html` this conversation has produced, so the person can go back.
    history: StdMutex<History>,
    /// The person went back to an earlier draft, and Codex has not been told yet.
    restored: AtomicBool,
}

impl ChatSession {
    /// Keeps the file in the work folder if it is new to this conversation. Returns its SHA-256
    /// when there is a readable file.
    fn keep_current(&self, loaded: bool) -> Option<String> {
        let bytes = chat::read_draft(&self.scratch).ok()?;
        let sha = hex::encode(sha2::Sha256::digest(&bytes));
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        self.history.lock().unwrap().record(bytes, loaded, now);
        Some(sha)
    }
}

/// One thing Codex was given to read, shown in the Sources panel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry {
    /// `app` (a tool from the library), `guide` or `instructions`.
    pub kind: &'static str,
    pub title: String,
    pub detail: String,
    pub tool_id: Option<String>,
}

/// What the interface shows when a session opens.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatStarted {
    pub model: Option<String>,
    pub version: Option<String>,
    /// The private work folder, with the home folder shown as `~`.
    pub directory: String,
    /// What Codex was given to read before the first message.
    pub sources: Vec<SourceEntry>,
}

/// `SANCTUM_CODEX_BIN` lets a development build run a Codex of the developer's choosing. A
/// release build never reads it.
fn debug_override() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("SANCTUM_CODEX_BIN").map(PathBuf::from)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

impl AgentState {
    /// `data_dir` is Sanctum's app data folder; Codex gets its own `CODEX_HOME` and its
    /// program folder inside it.
    pub fn new(
        data_dir: &Path,
        version: &str,
        release: Option<Release>,
        transport: Result<Arc<dyn Transport>, String>,
    ) -> AgentState {
        let enabled_path = data_dir.join("agent").join("enabled");
        AgentState {
            enabled: AtomicBool::new(enabled_path.is_file()),
            enabled_path,
            home: data_dir.join("agent").join("codex-home"),
            bin_dir: data_dir.join("agent").join("bin"),
            sessions_dir: data_dir.join("agent").join("sessions"),
            previews_dir: data_dir.join("agent").join("previews"),
            previews_cleaned: AtomicBool::new(false),
            instructions_path: data_dir.join("agent").join("instructions.md"),
            version: version.to_owned(),
            release,
            transport,
            program_override: debug_override(),
            process: Mutex::new(None),
            signing_in: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            chat: Mutex::new(None),
            turn_running: AtomicBool::new(false),
            turn_slot: StdMutex::new(None),
        }
    }

    /// Building apps is off until the person turns it on in Settings. Nothing starts, downloads
    /// or signs in while it is off.
    fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    fn set_enabled(&self, on: bool) -> std::io::Result<()> {
        if on {
            if let Some(dir) = self.enabled_path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&self.enabled_path, b"on\n")?;
        } else {
            match std::fs::remove_file(&self.enabled_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        self.enabled.store(on, Ordering::SeqCst);
        Ok(())
    }

    fn require_enabled(&self) -> Result<(), AgentCommandError> {
        if self.enabled() {
            Ok(())
        } else {
            Err(AgentCommandError::disabled())
        }
    }

    fn supported(&self) -> bool {
        self.program_override.is_some() || self.release.is_some()
    }

    fn installed(&self) -> bool {
        match (&self.program_override, &self.release) {
            (Some(p), _) => p.is_file(),
            (None, Some(r)) => install::is_present(&self.bin_dir, r),
            _ => false,
        }
    }

    /// The program to run, after checking it is the pinned one.
    async fn program(&self) -> Result<PathBuf, AgentCommandError> {
        if let Some(p) = &self.program_override {
            return Ok(p.clone());
        }
        let rel = self
            .release
            .as_ref()
            .ok_or_else(AgentCommandError::unsupported)?;
        if install::verify(&self.bin_dir, rel).await {
            Ok(install::binary_path(&self.bin_dir, rel))
        } else {
            Err(AgentCommandError::new(
                "not_installed",
                "Codex has not been downloaded yet, or the saved copy is damaged. Sign in again to download it.",
            ))
        }
    }

    /// The running process, started if there is none (or the old one died).
    async fn ensure(&self) -> Result<Arc<AgentProcess>, AgentCommandError> {
        self.require_enabled()?;
        let mut slot = self.process.lock().await;
        if let Some(p) = slot.as_ref() {
            if !p.rpc.is_closed() {
                return Ok(p.clone());
            }
        }
        let program = self.program().await?;
        let p = Arc::new(AgentProcess::start(&program, &self.home, &self.version).await?);
        *slot = Some(p.clone());
        Ok(p)
    }

    /// Downloads Codex if it is not there. A no-op when it is, or when a development override
    /// is in use.
    async fn ensure_installed(
        &self,
        progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), AgentCommandError> {
        self.require_enabled()?;
        if self.program_override.is_some() {
            return Ok(());
        }
        let rel = self
            .release
            .as_ref()
            .ok_or_else(AgentCommandError::unsupported)?;
        let transport = self.transport.as_ref().map_err(|m| {
            AgentCommandError::new(
                "download_failed",
                format!("Downloads are unavailable on this system: {m}"),
            )
        })?;
        install::install(
            transport.as_ref(),
            &self.bin_dir,
            rel,
            &self.cancelled,
            progress,
        )
        .await?;
        Ok(())
    }

    /// Stops the process, if any.
    async fn stop(&self) {
        let taken = self.process.lock().await.take();
        if let Some(p) = taken {
            p.shutdown().await;
        }
    }

    /// Called when Sanctum quits. Work folders do not outlive the app.
    pub async fn shutdown(&self) {
        self.stop().await;
        self.chat.lock().await.take();
        chat::clear_sessions(&self.sessions_dir);
        let _ = std::fs::remove_dir_all(&self.previews_dir);
    }
}

/// Sent to every window when building apps is turned on or off.
const ENABLED_EVENT: &str = "agent-enabled";

/// What the interface needs to decide what to show.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetup {
    /// Sanctum has a Codex build for this computer.
    pub supported: bool,
    /// The person turned building apps on in Settings. Off until they do.
    pub enabled: bool,
    /// Codex is already downloaded.
    pub installed: bool,
    /// Size of the first-use download, in megabytes, for the sentence that asks.
    pub download_mb: u64,
}

/// What the interface shows about the account.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub signed_in: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
}

impl From<Status> for AgentAccount {
    fn from(s: Status) -> Self {
        AgentAccount {
            signed_in: s.signed_in,
            email: s.email,
            plan: s.plan,
        }
    }
}

#[derive(Debug, Serialize, Clone, Copy)]
struct DownloadProgress {
    done: u64,
    total: u64,
}

/// An error the interface can act on: `code` is stable, `message` is for people.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AgentCommandError {
    pub code: &'static str,
    pub message: String,
}

impl AgentCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        AgentCommandError {
            code,
            message: message.into(),
        }
    }
    fn disabled() -> Self {
        Self::new(
            "disabled",
            "Building apps is turned off. You can turn it on in Settings.",
        )
    }
    fn unsupported() -> Self {
        Self::new(
            "unsupported",
            "Building apps is not available on this kind of computer yet.",
        )
    }
}

impl From<AgentError> for AgentCommandError {
    fn from(e: AgentError) -> Self {
        let code = match &e {
            AgentError::Rpc(_) => "process",
            AgentError::Protocol(_) => "protocol",
            AgentError::BadAuthUrl => "bad_address",
            AgentError::Browser(_) => "browser",
            AgentError::LoginFailed(_) => "login_failed",
            AgentError::LoginTimeout => "timeout",
            AgentError::Spawn(_) => "process",
            AgentError::TurnTimeout => "turn_timeout",
            AgentError::TooManySteps => "too_many_steps",
            AgentError::Scratch(_) => "scratch",
        };
        AgentCommandError::new(code, e.to_string())
    }
}

impl From<InstallError> for AgentCommandError {
    fn from(e: InstallError) -> Self {
        match e {
            InstallError::Cancelled => AgentCommandError::new("cancelled", "Cancelled."),
            other => AgentCommandError::new("download_failed", other.to_string()),
        }
    }
}

/// The windows that may use the agent commands: the main window and the Create window. Both
/// show Sanctum's own interface. A tool window has no IPC at all and is never on this list.
fn is_host_label(label: &str) -> bool {
    label == "main" || label == CREATE_WINDOW
}

fn require_host(window: &Window) -> Result<(), AgentCommandError> {
    if is_host_label(window.label()) {
        Ok(())
    } else {
        Err(AgentCommandError::new(
            "forbidden",
            "This is only available in Sanctum's own windows.",
        ))
    }
}

/// Clears the "sign-in running" flag however the sign-in ends.
struct SigningIn<'a>(&'a AtomicBool);
impl Drop for SigningIn<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ── The logic, without Tauri, so it can be tested ────────────────────────────────────────────

fn setup_of(state: &AgentState) -> AgentSetup {
    AgentSetup {
        supported: state.supported(),
        enabled: state.enabled(),
        installed: state.installed(),
        download_mb: state.release.as_ref().map_or(0, |r| {
            install::pending_download_bytes(&state.bin_dir, r).div_ceil(1_000_000)
        }),
    }
}

async fn account_of(state: &AgentState) -> Result<AgentAccount, AgentCommandError> {
    let p = state.ensure().await?;
    Ok(account::status(&p.rpc).await?.into())
}

async fn sign_in_with<F>(
    state: &AgentState,
    open: F,
    timeout: std::time::Duration,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<AgentAccount, AgentCommandError>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    if state.signing_in.swap(true, Ordering::SeqCst) {
        return Err(AgentCommandError::new(
            "busy",
            "A sign-in is already in progress.",
        ));
    }
    let _flag = SigningIn(&state.signing_in);
    state.cancelled.store(false, Ordering::SeqCst);

    // The first time: download Codex. The person has just clicked, and the screen said so.
    state.ensure_installed(progress).await?;

    let p = state.ensure().await?;
    // Already signed in: no browser, no new login.
    let now = account::status(&p.rpc).await?;
    if now.signed_in {
        return Ok(now.into());
    }
    match account::sign_in(&p.rpc, open, timeout).await {
        Ok(s) => Ok(s.into()),
        Err(_) if state.cancelled.load(Ordering::SeqCst) => Err(AgentCommandError::new(
            "cancelled",
            "Sign-in was cancelled.",
        )),
        Err(e) => {
            // A dead connection is replaced on the next command.
            if matches!(e, AgentError::Rpc(super::rpc::RpcError::Closed)) {
                state.stop().await;
            }
            Err(e.into())
        }
    }
}

/// Cancels a download or a sign-in. For a sign-in the process is stopped, which also closes
/// the local page Codex opened to receive the browser's answer.
async fn cancel_with(state: &AgentState) {
    if state.signing_in.load(Ordering::SeqCst) {
        state.cancelled.store(true, Ordering::SeqCst);
        state.stop().await;
    }
}

async fn sign_out_with(state: &AgentState) -> Result<AgentAccount, AgentCommandError> {
    let p = state.ensure().await?;
    account::sign_out(&p.rpc).await?;
    Ok(account::status(&p.rpc).await?.into())
}

/// Opens a build session: a new scratch folder and a Codex thread that may write only there.
/// Needs a ChatGPT sign-in. Replaces any session that is open.
#[cfg(test)]
async fn chat_start_with(state: &AgentState) -> Result<ChatStarted, AgentCommandError> {
    chat_start_from_with(state, None).await
}

/// The person's standing instructions, or empty when none are set.
fn read_instructions(state: &AgentState) -> String {
    std::fs::read_to_string(&state.instructions_path)
        .map(|t| t.chars().take(chat::MAX_INSTRUCTIONS_CHARS).collect())
        .unwrap_or_default()
}

fn write_instructions(state: &AgentState, text: &str) -> Result<String, AgentCommandError> {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    let text = text.trim().to_owned();
    if text.chars().count() > chat::MAX_INSTRUCTIONS_CHARS {
        return Err(AgentCommandError::new(
            "bad_instructions",
            format!(
                "Instructions can be at most {} characters.",
                chat::MAX_INSTRUCTIONS_CHARS
            ),
        ));
    }
    let scratch = |e: std::io::Error| AgentCommandError::new("scratch", e.to_string());
    if text.is_empty() {
        match std::fs::remove_file(&state.instructions_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(scratch(e)),
        }
    } else {
        if let Some(parent) = state.instructions_path.parent() {
            std::fs::create_dir_all(parent).map_err(scratch)?;
        }
        std::fs::write(&state.instructions_path, &text).map_err(scratch)?;
    }
    Ok(text)
}

/// As [`chat_start_with`], optionally starting from an app in the library: its file is put in
/// the work folder as `app.html`, Codex is told it is the app to change, and a draft saved from
/// this session becomes a new version of that app.
async fn chat_start_from_with(
    state: &AgentState,
    source: Option<draft::Source>,
) -> Result<ChatStarted, AgentCommandError> {
    if state.turn_running.load(Ordering::SeqCst) {
        return Err(AgentCommandError::new(
            "busy",
            "Codex is still working. Stop it first.",
        ));
    }
    let p = state.ensure().await?;
    if !account::status(&p.rpc).await?.signed_in {
        return Err(AgentCommandError::new(
            "not_signed_in",
            "Sign in with ChatGPT first.",
        ));
    }
    let mut slot = state.chat.lock().await;
    // Any earlier session, and anything a crash left behind, goes first.
    slot.take();
    chat::clear_sessions(&state.sessions_dir);
    let instructions = read_instructions(state);
    let rules = chat::agents_md_with(&instructions, source.as_ref().map(|s| s.name.as_str()));
    let scratch = chat::create_scratch_with(
        &state.sessions_dir,
        &rules,
        source.as_ref().map(|s| s.bytes.as_slice()),
    )?;
    match chat::start_thread(&p.rpc, &scratch).await {
        Ok(info) => {
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from);
            let mut sources = Vec::new();
            if let Some(src) = &source {
                sources.push(SourceEntry {
                    kind: "app",
                    title: src.name.clone(),
                    detail: format!(
                        "Version {}, {} KB. Its file is app.html in the work folder, and goes to OpenAI with your first message.",
                        src.version_num,
                        src.bytes.len().div_ceil(1024)
                    ),
                    tool_id: Some(src.tool_id.clone()),
                });
            }
            sources.push(SourceEntry {
                kind: "guide",
                title: "Sanctum guide".into(),
                detail:
                    "The rules and what a tool can and cannot do here, including how to save files."
                        .into(),
                tool_id: None,
            });
            sources.push(SourceEntry {
                kind: "instructions",
                title: "Your instructions".into(),
                detail: if instructions.trim().is_empty() {
                    "None set.".into()
                } else {
                    format!("{} characters.", instructions.trim().chars().count())
                },
                tool_id: None,
            });
            let started = ChatStarted {
                model: info.model,
                version: info.version,
                directory: chat::tilde(&scratch, home.as_deref()),
                sources,
            };
            let session = ChatSession {
                thread_id: info.thread_id,
                scratch,
                tool_id: StdMutex::new(source.as_ref().map(|s| s.tool_id.clone())),
                history: StdMutex::new(History::default()),
                restored: AtomicBool::new(false),
            };
            if source.is_some() {
                session.keep_current(true);
            }
            *slot = Some(Arc::new(session));
            Ok(started)
        }
        Err(e) => {
            chat::remove_scratch(&state.sessions_dir, &scratch);
            Err(e.into())
        }
    }
}

/// Sends one prompt in the open session and waits for the turn to end. `on_update` receives the
/// reply as it streams and each step Codex takes.
async fn chat_send_with(
    state: &AgentState,
    text: &str,
    on_update: &mut (dyn FnMut(Update) + Send),
    limits: Limits,
) -> Result<TurnOutcome, AgentCommandError> {
    let text = chat::validate_prompt(text).map_err(|m| AgentCommandError::new("bad_prompt", m))?;
    let session = state.chat.lock().await.clone().ok_or_else(|| {
        AgentCommandError::new("no_session", "There is no open session. Start a new one.")
    })?;
    if state.turn_running.swap(true, Ordering::SeqCst) {
        return Err(AgentCommandError::new(
            "busy",
            "Codex is still working on the last message.",
        ));
    }
    struct Running<'a>(&'a AtomicBool);
    impl Drop for Running<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _flag = Running(&state.turn_running);

    let p = state.ensure().await?;
    // Codex remembers the file it last wrote. If the person went back to another draft, say so
    // once, so it reads the file again instead of editing from memory.
    let told;
    let text = if session.restored.swap(false, Ordering::SeqCst) {
        told = format!("{RESTORED_NOTE}\n\n{text}");
        told.as_str()
    } else {
        text
    };
    let result = chat::run_turn(
        &p.rpc,
        &session.thread_id,
        &session.scratch,
        text,
        &state.turn_slot,
        on_update,
        limits,
    )
    .await;
    // Whatever the turn ended as, a changed file is a draft worth keeping.
    session.keep_current(false);
    match result {
        Ok(o) => Ok(o),
        Err(e) => {
            // A dead connection loses the thread. Drop the session, and the process is
            // replaced on the next command.
            if matches!(e, AgentError::Rpc(super::rpc::RpcError::Closed)) {
                state.stop().await;
                if let Some(s) = state.chat.lock().await.take() {
                    chat::remove_scratch(&state.sessions_dir, &s.scratch);
                }
            }
            Err(e.into())
        }
    }
}

/// Told to Codex once, before the next message, after the person went back to an earlier draft.
const RESTORED_NOTE: &str = "[Sanctum: the person put an earlier version of app.html back. Read the file again before you change it.]";

/// Asks Codex to stop the running turn. Does nothing when none is running.
async fn chat_stop_with(state: &AgentState) {
    let turn = state.turn_slot.lock().unwrap().clone();
    let session = state.chat.lock().await.clone();
    let process = state.process.lock().await.clone();
    if let (Some(turn), Some(s), Some(p)) = (turn, session, process) {
        chat::interrupt(&p.rpc, &s.thread_id, &turn).await;
    }
}

/// Ends the session and deletes its folder.
async fn chat_close_with(state: &AgentState) {
    chat_stop_with(state).await;
    if let Some(s) = state.chat.lock().await.take() {
        chat::remove_scratch(&state.sessions_dir, &s.scratch);
    }
}

/// Most draft previews open at once.
const MAX_PREVIEWS: usize = 8;

/// Makes a private copy of the open session's draft, for a preview window to show. Returns the
/// id of the preview, the folder that holds the copy (as `index.html`), and the copy's SHA-256. The copy is made by
/// Sanctum from a checked read, so the agent cannot change what the window shows afterwards.
#[cfg(test)]
async fn preview_draft_with(
    state: &AgentState,
) -> Result<(String, PathBuf, String), AgentCommandError> {
    preview_version_with(state, None).await
}

/// As [`preview_draft_with`]. With `sha`, previews that earlier draft of this conversation
/// instead of the file in the work folder.
async fn preview_version_with(
    state: &AgentState,
    sha: Option<&str>,
) -> Result<(String, PathBuf, String), AgentCommandError> {
    let session = state.chat.lock().await.clone().ok_or_else(|| {
        AgentCommandError::new("no_session", "There is no open session. Start a new one.")
    })?;
    let bytes = match sha {
        Some(sha) => session
            .history
            .lock()
            .unwrap()
            .get(sha)
            .map(|k| k.bytes.clone())
            .ok_or_else(|| AgentCommandError::new("no_draft", "That draft is no longer kept."))?,
        None => chat::read_draft(&session.scratch).map_err(|e| match e {
            chat::DraftError::Missing => {
                AgentCommandError::new("no_draft", "Codex has not written app.html yet.")
            }
            chat::DraftError::TooLarge => AgentCommandError::new(
                "draft_too_large",
                "app.html is larger than Sanctum accepts. Ask Codex to make it smaller.",
            ),
            chat::DraftError::Io(m) => AgentCommandError::new("scratch", m),
        })?,
    };
    // Leftovers of a crash, once per run, before the first preview.
    if !state.previews_cleaned.swap(true, Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&state.previews_dir);
    }
    let open = std::fs::read_dir(&state.previews_dir).map_or(0, |d| d.count());
    if open >= MAX_PREVIEWS {
        return Err(AgentCommandError::new(
            "too_many_previews",
            "Close a preview window first.",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = state.previews_dir.join(&id);
    let scratch_err = |e: std::io::Error| AgentCommandError::new("scratch", e.to_string());
    std::fs::create_dir_all(&dir).map_err(scratch_err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    if let Err(e) = std::fs::write(dir.join("index.html"), &bytes) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(scratch_err(e));
    }
    Ok((id, dir, hex::encode(sha2::Sha256::digest(&bytes))))
}

/// The drafts this conversation has produced, newest first, with the one in the work folder
/// marked.
async fn history_with(state: &AgentState) -> Result<Vec<history::Entry>, AgentCommandError> {
    let session = state.chat.lock().await.clone().ok_or_else(|| {
        AgentCommandError::new("no_session", "There is no open session. Start a new one.")
    })?;
    // A file written since the last turn ended (never, normally) is kept too.
    let current = session.keep_current(false);
    let list = session.history.lock().unwrap().list(current.as_deref());
    Ok(list)
}

/// Puts an earlier draft of this conversation back as `app.html`. Refused while Codex is
/// working, since it could write over it. Codex is told on the next message.
async fn restore_with(state: &AgentState, sha: &str) -> Result<chat::Draft, AgentCommandError> {
    if state.turn_running.load(Ordering::SeqCst) {
        return Err(AgentCommandError::new(
            "busy",
            "Codex is still working. Stop it first.",
        ));
    }
    let session = state.chat.lock().await.clone().ok_or_else(|| {
        AgentCommandError::new("no_session", "There is no open session. Start a new one.")
    })?;
    // Keep what is there now first, so going back never loses a draft.
    session.keep_current(false);
    let bytes = session
        .history
        .lock()
        .unwrap()
        .get(sha)
        .map(|k| k.bytes.clone())
        .ok_or_else(|| AgentCommandError::new("no_draft", "That draft is no longer kept."))?;
    chat::write_draft(&session.scratch, &bytes)
        .map_err(|m| AgentCommandError::new("scratch", m))?;
    session.restored.store(true, Ordering::SeqCst);
    chat::draft_of(&session.scratch)
        .ok_or_else(|| AgentCommandError::new("scratch", "The draft could not be put back."))
}

/// Event the main window listens for: the library changed (a draft was added from the Create
/// window), so the Tool Vault should reload.
pub const LIBRARY_EVENT: &str = "library-changed";

/// The open session and its draft, read as checked text.
async fn open_draft(state: &AgentState) -> Result<(Arc<ChatSession>, String), AgentCommandError> {
    let session = state.chat.lock().await.clone().ok_or_else(|| {
        AgentCommandError::new("no_session", "There is no open session. Start a new one.")
    })?;
    let bytes = chat::read_draft(&session.scratch).map_err(|e| match e {
        chat::DraftError::Missing => {
            AgentCommandError::new("no_draft", "Codex has not written app.html yet.")
        }
        chat::DraftError::TooLarge => AgentCommandError::new(
            "draft_too_large",
            "app.html is larger than Sanctum accepts. Ask Codex to make it smaller.",
        ),
        chat::DraftError::Io(m) => AgentCommandError::new("scratch", m),
    })?;
    let html = draft::text_of(bytes).map_err(|m| AgentCommandError::new("draft_not_text", m))?;
    Ok((session, html))
}

fn session_tool(session: &ChatSession) -> Option<String> {
    session.tool_id.lock().unwrap().clone()
}

/// What the person reads before deciding to add the draft.
async fn scan_draft_with(
    state: &AgentState,
    pool: &sqlx::SqlitePool,
) -> Result<draft::DraftReport, AgentCommandError> {
    let (session, html) = open_draft(state).await?;
    draft::report(pool, &html, session_tool(&session).as_deref())
        .await
        .map_err(|m| AgentCommandError::new("library", m))
}

/// Adds the draft to the library, or as a new version of the tool this session added before.
async fn add_draft_with(
    state: &AgentState,
    pool: &sqlx::SqlitePool,
    data_dir: &Path,
) -> Result<draft::Added, AgentCommandError> {
    let (session, html) = open_draft(state).await?;
    let added = draft::add(pool, data_dir, &html, session_tool(&session).as_deref())
        .await
        .map_err(|m| AgentCommandError::new("library", m))?;
    // Only a tool this session made is remembered as "its" tool.
    if matches!(
        added.outcome,
        draft::AddOutcome::Added | draft::AddOutcome::NewVersion | draft::AddOutcome::Unchanged
    ) {
        *session.tool_id.lock().unwrap() = Some(added.tool.id.clone());
    }
    Ok(added)
}

// ── The commands ──────────────────────────────────────────────────────────────────────────────

/// Whether Sanctum can set up the agent here and whether it already has. Looks at files only.
#[tauri::command]
pub fn agent_setup(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentSetup, AgentCommandError> {
    require_host(&window)?;
    Ok(setup_of(&state))
}

/// Turns building apps on or off. Off is the default. Turning it off ends any open session and
/// stops Codex, and leaves the sign-in and the downloaded program where they are.
#[tauri::command]
pub async fn agent_set_enabled(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
    on: bool,
) -> Result<AgentSetup, AgentCommandError> {
    require_host(&window)?;
    if on && !state.supported() {
        return Err(AgentCommandError::unsupported());
    }
    state
        .set_enabled(on)
        .map_err(|e| AgentCommandError::new("io", format!("Could not save the setting: {e}")))?;
    if !on {
        state.shutdown().await;
    }
    // Every Sanctum window shows or hides its Create controls to match.
    let _ = app.emit(ENABLED_EVENT, on);
    Ok(setup_of(&state))
}

/// The signed-in account. Starts the local Codex process if it is not running; no request
/// leaves the computer for this. Does not download anything.
#[tauri::command]
pub async fn agent_account(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentAccount, AgentCommandError> {
    require_host(&window)?;
    account_of(&state).await
}

/// Signs in with ChatGPT. The first time it downloads Codex (progress arrives as
/// `agent-download` events). Codex then starts the flow, Sanctum opens the address in the
/// browser and waits. Returns at once, without a browser, if there is already a sign-in.
#[tauri::command]
pub async fn agent_sign_in(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentAccount, AgentCommandError> {
    require_host(&window)?;
    let target = window.label().to_owned();
    let emit = move |done: u64, total: u64| {
        let _ = app.emit_to(
            target.as_str(),
            DOWNLOAD_EVENT,
            DownloadProgress { done, total },
        );
    };
    sign_in_with(
        &state,
        |url| webbrowser::open(url).map_err(|e| e.to_string()),
        SIGN_IN_TIMEOUT,
        &emit,
    )
    .await
}

/// Stops a download or a sign-in that is waiting.
#[tauri::command]
pub async fn agent_cancel_sign_in(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<(), AgentCommandError> {
    require_host(&window)?;
    cancel_with(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn agent_sign_out(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentAccount, AgentCommandError> {
    require_host(&window)?;
    sign_out_with(&state).await
}

/// Event the Create window listens for: the person asked to change another app while the window
/// was already open.
pub const SOURCE_EVENT: &str = "agent-source";

/// An app from the library the person wants to change with Codex.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRequest {
    tool_id: String,
    name: String,
}

/// Opens the Create window, or brings it forward if it is open. It is a window of its own so a
/// session survives while you use the rest of Sanctum; closing it ends the session and deletes
/// its work folder.
#[tauri::command]
pub async fn agent_open_create_window(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
    db: State<'_, crate::db::DbState>,
    tool_id: Option<String>,
) -> Result<(), AgentCommandError> {
    require_host(&window)?;
    if !state.supported() {
        return Err(AgentCommandError::unsupported());
    }
    state.require_enabled()?;
    // An app to change: it must exist, and its id goes into a URL, so it must be a plain id.
    let source = match tool_id {
        Some(id) => {
            let valid = uuid::Uuid::parse_str(&id).is_ok();
            let tool = if valid {
                crate::commands::ingest::load_tool_record(&db.0, &id)
                    .await
                    .ok()
            } else {
                None
            };
            let tool = tool.ok_or_else(|| {
                AgentCommandError::new("source", "That app is not in your library any more.")
            })?;
            Some(SourceRequest {
                tool_id: tool.id,
                name: tool.name,
            })
        }
        None => None,
    };
    if let Some(existing) = app.get_webview_window(CREATE_WINDOW) {
        if let Some(src) = &source {
            let _ = app.emit_to(CREATE_WINDOW, SOURCE_EVENT, src);
        }
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AgentCommandError::new("window", e.to_string()))?;
        return Ok(());
    }
    let created = WebviewWindowBuilder::new(
        &app,
        CREATE_WINDOW,
        WebviewUrl::App(
            match &source {
                Some(src) => format!("index.html?window=create&source={}", src.tool_id),
                None => "index.html?window=create".to_owned(),
            }
            .into(),
        ),
    )
    .title("Create your own app")
    .inner_size(960.0, 760.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .build()
    .map_err(|e| AgentCommandError::new("window", e.to_string()))?;
    let handle = app.clone();
    created.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AgentState>();
                chat_close_with(&state).await;
            });
        }
    });
    Ok(())
}

/// Opens a build session. Needs a ChatGPT sign-in. Starts the local Codex process if needed;
/// no request leaves the computer until the first message is sent.
///
/// With `source`, the session starts from that app in the library (see [`chat_start_from_with`]).
#[tauri::command]
pub async fn agent_chat_start(
    window: Window,
    state: State<'_, AgentState>,
    db: State<'_, crate::db::DbState>,
    data_dir: State<'_, crate::AppDataDir>,
    source: Option<String>,
) -> Result<ChatStarted, AgentCommandError> {
    require_host(&window)?;
    let source = match source {
        Some(id) => Some(
            draft::load_source(&db.0, &data_dir.0, &id)
                .await
                .map_err(|m| AgentCommandError::new("source", m))?,
        ),
        None => None,
    };
    chat_start_from_with(&state, source).await
}

/// The drafts this conversation has produced, newest first.
#[tauri::command]
pub async fn agent_draft_history(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<Vec<history::Entry>, AgentCommandError> {
    require_host(&window)?;
    history_with(&state).await
}

/// Puts an earlier draft of this conversation back as the current one.
#[tauri::command]
pub async fn agent_restore_draft(
    window: Window,
    state: State<'_, AgentState>,
    sha: String,
) -> Result<chat::Draft, AgentCommandError> {
    require_host(&window)?;
    restore_with(&state, &sha).await
}

/// The person's standing instructions for every app.
#[tauri::command]
pub async fn agent_get_instructions(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<String, AgentCommandError> {
    require_host(&window)?;
    Ok(read_instructions(&state))
}

/// Saves the standing instructions. They apply to conversations started after this.
#[tauri::command]
pub async fn agent_set_instructions(
    window: Window,
    state: State<'_, AgentState>,
    text: String,
) -> Result<String, AgentCommandError> {
    require_host(&window)?;
    write_instructions(&state, &text)
}

/// One reply fragment, as the interface receives it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ChatText {
    item_id: String,
    text: String,
}

/// Sends a message and returns when Codex has finished. The reply arrives meanwhile as
/// `agent-chat` events.
#[tauri::command]
pub async fn agent_chat_send(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
    text: String,
) -> Result<TurnOutcome, AgentCommandError> {
    require_host(&window)?;
    let target = window.label().to_owned();
    let mut emit = move |u: Update| match u {
        Update::Text { item_id, text } => {
            let _ = app.emit_to(
                target.as_str(),
                CHAT_EVENT,
                ChatText {
                    item_id: item_id.to_owned(),
                    text: text.to_owned(),
                },
            );
        }
        Update::Activity(a) => {
            let _ = app.emit_to(target.as_str(), ACTIVITY_EVENT, a);
        }
    };
    chat_send_with(&state, &text, &mut emit, Limits::default()).await
}

/// What the open session's draft is and what it asks for, from the scan. Nothing is granted.
#[tauri::command]
pub async fn agent_scan_draft(
    window: Window,
    state: State<'_, AgentState>,
    db: State<'_, crate::db::DbState>,
) -> Result<draft::DraftReport, AgentCommandError> {
    require_host(&window)?;
    scan_draft_with(&state, &db.0).await
}

/// Adds the draft to the library with no approvals, marked as made by the agent. A later draft
/// from the same session becomes a new version of that tool.
#[tauri::command]
pub async fn agent_add_draft(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
    db: State<'_, crate::db::DbState>,
    data_dir: State<'_, crate::AppDataDir>,
) -> Result<draft::Added, AgentCommandError> {
    require_host(&window)?;
    let added = add_draft_with(&state, &db.0, &data_dir.0).await?;
    if added.outcome != draft::AddOutcome::Unchanged {
        let _ = app.emit_to("main", LIBRARY_EVENT, ());
    }
    Ok(added)
}

/// Opens the draft in a window of its own. The page runs like a tool with nothing approved: no
/// network, no devices, no access to Sanctum. Nothing is added to the library.
#[tauri::command]
pub async fn agent_preview_draft(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
    sha: Option<String>,
) -> Result<(), AgentCommandError> {
    require_host(&window)?;
    let (id, dir, sha) = preview_version_with(&state, sha.as_deref()).await?;
    // An organisation that limits which tools may run limits drafts too: a draft is a tool that
    // nobody has approved, so under a pinned list it is refused, like any other unlisted file.
    if let Err(m) = crate::policy::check_run(&crate::policy::load(), &sha) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(AgentCommandError::new("policy", m));
    }
    crate::commands::runner::open_draft_window(&app, &id, dir)
        .map_err(|m| AgentCommandError::new("window", m))
}

/// Stops the running turn.
#[tauri::command]
pub async fn agent_chat_stop(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<(), AgentCommandError> {
    require_host(&window)?;
    chat_stop_with(&state).await;
    Ok(())
}

/// Ends the session and deletes its work folder.
#[tauri::command]
pub async fn agent_chat_close(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<(), AgentCommandError> {
    require_host(&window)?;
    chat_close_with(&state).await;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agent::install::testing::{dir, release, targz, CDN, URL};
    use crate::registry::fetch::testing::{Mock, Script};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    fn no_progress(_: u64, _: u64) {}

    /// The text of a stand-in `codex`. `signed_in` is what the first `account/read` answers.
    /// A sign-in then completes by itself. The script reads one line per request, in order.
    fn fake_script(signed_in: bool) -> Vec<u8> {
        let acct = r#"{"account":{"type":"chatgpt","email":"me@example.com","planType":"pro"},"requiresOpenaiAuth":true}"#;
        let none = r#"{"account":null,"requiresOpenaiAuth":true}"#;
        let first = if signed_in { acct } else { none };
        format!(
            r#"#!/bin/sh
read line
echo '{{"id":1,"result":{{"userAgent":"fake"}}}}'
read line
read line
echo '{{"id":2,"result":{first}}}'
read line
echo '{{"id":3,"result":{{"type":"chatgpt","loginId":"L1","authUrl":"https://auth.example.com/go"}}}}'
echo '{{"method":"account/login/completed","params":{{"loginId":"L1","success":true}}}}'
read line
echo '{{"id":4,"result":{acct}}}'
read line
"#
        )
        .into_bytes()
    }

    /// A state that already has a program (a stand-in `codex`) in place of the download.
    fn with_program(script: &[u8]) -> (AgentState, PathBuf) {
        let d = dir();
        let bin = d.join("codex");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut st = AgentState::new(&d, "0.0.0-test", None, Err("none".into()));
        st.set_enabled(true).unwrap();
        st.program_override = Some(bin);
        (st, d)
    }

    /// A state with nothing installed and a scripted server that serves `script` as Codex.
    fn with_download(script: &[u8]) -> (AgentState, PathBuf, Arc<Mock>) {
        let archive = targz(&[("codex-test", script)]);
        let rel = release(script, &archive);
        let mock = Arc::new(Mock::new());
        mock.route(URL, Script::Redirect(302, CDN.into()));
        mock.serve(CDN, &archive);
        let d = dir();
        let transport: Arc<dyn Transport> = mock.clone();
        let mut st = AgentState::new(&d, "0.0.0-test", Some(rel), Ok(transport));
        st.set_enabled(true).unwrap();
        st.program_override = None;
        (st, d, mock)
    }

    #[tokio::test]
    async fn building_apps_is_off_until_the_person_turns_it_on() {
        let (st, d) = with_program(&fake_script(true));
        // A fresh data folder: off, and nothing starts or downloads.
        let fresh = AgentState::new(&dir(), "0.0.0-test", None, Err("none".into()));
        assert!(!fresh.enabled());
        assert_eq!(fresh.require_enabled().unwrap_err().code, "disabled");
        assert_eq!(fresh.ensure().await.err().unwrap().code, "disabled");
        assert_eq!(
            fresh.ensure_installed(&|_, _| {}).await.unwrap_err().code,
            "disabled"
        );
        assert!(!setup_of(&fresh).enabled);
        // On: the choice is kept for the next start. Off again removes it.
        st.set_enabled(false).unwrap();
        assert!(!AgentState::new(&d, "0.0.0-test", None, Err("x".into())).enabled());
        st.set_enabled(true).unwrap();
        assert!(AgentState::new(&d, "0.0.0-test", None, Err("x".into())).enabled());
        st.set_enabled(false).unwrap();
        assert_eq!(st.ensure().await.err().unwrap().code, "disabled");
        st.set_enabled(false).unwrap();
    }

    #[tokio::test]
    async fn the_first_sign_in_downloads_codex_then_signs_in() {
        let (state, d, mock) = with_download(&fake_script(false));
        assert_eq!(
            setup_of(&state),
            AgentSetup {
                supported: true,
                enabled: true,
                installed: false,
                download_mb: 1
            }
        );
        let opened = Arc::new(StdMutex::new(Vec::<String>::new()));
        let o = opened.clone();
        let progress = Arc::new(StdMutex::new(Vec::<(u64, u64)>::new()));
        let pr = progress.clone();
        let acct = sign_in_with(
            &state,
            move |u| {
                o.lock().unwrap().push(u.to_owned());
                Ok(())
            },
            Duration::from_secs(5),
            &move |a, b| pr.lock().unwrap().push((a, b)),
        )
        .await
        .unwrap();
        assert!(acct.signed_in);
        assert_eq!(acct.email.as_deref(), Some("me@example.com"));
        assert_eq!(acct.plan.as_deref(), Some("Pro"));
        assert_eq!(
            opened.lock().unwrap().as_slice(),
            ["https://auth.example.com/go"]
        );
        assert!(!progress.lock().unwrap().is_empty());
        assert!(setup_of(&state).installed);
        assert!(mock.call_count() >= 1);
        // Signing in again does not download again.
        let before = mock.call_count();
        state.stop().await;
        sign_in_with(&state, |_| Ok(()), Duration::from_secs(5), &no_progress)
            .await
            .ok();
        assert_eq!(mock.call_count(), before);
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_download_that_fails_the_check_never_runs() {
        let (mut state, d, _mock) = with_download(&fake_script(false));
        // Pin a different hash than what is served.
        state.release.as_mut().unwrap().pin.archive_sha256 = "0".repeat(64);
        let e = sign_in_with(
            &state,
            |_| panic!("the browser must not open"),
            Duration::from_secs(5),
            &no_progress,
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "download_failed");
        assert!(!setup_of(&state).installed);
        assert!(state.process.lock().await.is_none());
        assert!(!state.signing_in.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_program_changed_after_install_is_not_started() {
        let (state, d, _mock) = with_download(&fake_script(true));
        sign_in_with(&state, |_| Ok(()), Duration::from_secs(5), &no_progress)
            .await
            .unwrap();
        state.stop().await;
        let rel = state.release.clone().unwrap();
        let path = install::binary_path(&state.bin_dir, &rel);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[20] ^= 1;
        std::fs::write(&path, bytes).unwrap();
        let e = account_of(&state).await.unwrap_err();
        assert_eq!(e.code, "not_installed");
        assert!(state.process.lock().await.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn no_build_for_this_computer_is_reported_not_attempted() {
        let d = dir();
        let mut state = AgentState::new(&d, "0.0.0-test", None, Err("x".into()));
        state.set_enabled(true).unwrap();
        state.program_override = None;
        assert_eq!(
            setup_of(&state),
            AgentSetup {
                supported: false,
                enabled: true,
                installed: false,
                download_mb: 0
            }
        );
        let e = sign_in_with(&state, |_| Ok(()), Duration::from_secs(1), &no_progress)
            .await
            .unwrap_err();
        assert_eq!(e.code, "unsupported");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn already_signed_in_never_opens_the_browser() {
        let (state, d) = with_program(&fake_script(true));
        let acct = sign_in_with(
            &state,
            |_| panic!("the browser must not open"),
            Duration::from_secs(5),
            &no_progress,
        )
        .await
        .unwrap();
        assert!(acct.signed_in);
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_second_sign_in_at_the_same_time_is_refused() {
        let (state, d) = with_program(&fake_script(false));
        state.signing_in.store(true, Ordering::SeqCst);
        let r = sign_in_with(&state, |_| Ok(()), Duration::from_secs(1), &no_progress).await;
        assert_eq!(r.unwrap_err().code, "busy");
        // The refused call must not clear the other sign-in's flag.
        assert!(state.signing_in.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancelling_a_sign_in_stops_the_wait_and_reports_it_as_cancelled() {
        // A codex that answers the handshake and the login start, then never completes.
        let script = br#"#!/bin/sh
read line
echo '{"id":1,"result":{"userAgent":"fake"}}'
read line
read line
echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
read line
echo '{"id":3,"result":{"type":"chatgpt","loginId":"L1","authUrl":"https://auth.example.com/go"}}'
exec sleep 30
"#;
        let (state, d) = with_program(script);
        let state = Arc::new(state);
        let s = state.clone();
        let t = tokio::spawn(async move {
            sign_in_with(&s, |_| Ok(()), Duration::from_secs(20), &no_progress).await
        });
        for _ in 0..100 {
            if state.signing_in.load(Ordering::SeqCst) && state.process.lock().await.is_some() {
                tokio::time::sleep(Duration::from_millis(150)).await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel_with(&state).await;
        let r = tokio::time::timeout(Duration::from_secs(5), t)
            .await
            .expect("the sign-in should end soon after cancel")
            .unwrap();
        assert_eq!(r.unwrap_err().code, "cancelled");
        assert!(state.process.lock().await.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancelling_a_download_reports_cancelled_and_installs_nothing() {
        let (state, d, mock) = with_download(&fake_script(false));
        let archive = targz(&[("codex-test", &fake_script(false))]);
        mock.route(
            CDN,
            Script::Chunks {
                declared_len: Some(archive.len() as u64),
                chunks: archive.chunks(16).map(<[u8]>::to_vec).collect(),
                delay: Duration::from_millis(20),
            },
        );
        let state = Arc::new(state);
        let s = state.clone();
        let t = tokio::spawn(async move {
            sign_in_with(&s, |_| Ok(()), Duration::from_secs(5), &no_progress).await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel_with(&state).await;
        let r = tokio::time::timeout(Duration::from_secs(5), t)
            .await
            .expect("the download should stop soon after cancel")
            .unwrap();
        assert_eq!(r.unwrap_err().code, "cancelled");
        assert!(!setup_of(&state).installed);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancel_without_a_sign_in_does_nothing() {
        let (state, d) = with_program(&fake_script(true));
        account_of(&state).await.unwrap();
        cancel_with(&state).await;
        assert!(
            state.process.lock().await.is_some(),
            "a running process is left alone"
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_program_that_cannot_start_is_a_process_error() {
        let d = dir();
        let mut state = AgentState::new(&d, "0.0.0-test", None, Err("x".into()));
        state.set_enabled(true).unwrap();
        state.program_override = Some(d.join("nope"));
        let e = account_of(&state).await.unwrap_err();
        assert_eq!(e.code, "process");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn errors_map_to_stable_codes() {
        use crate::agent::rpc::RpcError;
        let code = |e: AgentError| AgentCommandError::from(e).code;
        assert_eq!(code(AgentError::BadAuthUrl), "bad_address");
        assert_eq!(code(AgentError::LoginTimeout), "timeout");
        assert_eq!(code(AgentError::Browser("x".into())), "browser");
        assert_eq!(code(AgentError::LoginFailed("x".into())), "login_failed");
        assert_eq!(code(AgentError::Rpc(RpcError::Closed)), "process");
        assert_eq!(code(AgentError::Protocol("x".into())), "protocol");
        assert_eq!(
            AgentCommandError::from(InstallError::Cancelled).code,
            "cancelled"
        );
        assert_eq!(
            AgentCommandError::from(InstallError::Mismatch("checksum")).code,
            "download_failed"
        );
    }

    // ── Build sessions ──

    /// A stand-in `codex` for a session. After the turn starts it runs `after_turn`.
    fn chat_script(signed_in: bool, after_turn: &str) -> Vec<u8> {
        let acct = r#"{"account":{"type":"chatgpt","email":"me@example.com","planType":"pro"},"requiresOpenaiAuth":true}"#;
        let none = r#"{"account":null,"requiresOpenaiAuth":true}"#;
        let a = if signed_in { acct } else { none };
        format!(
            r#"#!/bin/sh
read line
echo '{{"id":1,"result":{{"userAgent":"fake"}}}}'
read line
read line
echo '{{"id":2,"result":{a}}}'
read line
echo '{{"id":3,"result":{{"thread":{{"id":"TH"}}}}}}'
read line
echo '{{"id":4,"result":{{"turn":{{"id":"T1","status":"inProgress","items":[]}}}}}}'
{after_turn}
read line
"#
        )
        .into_bytes()
    }

    const FINISH: &str = r#"echo '{"method":"item/agentMessage/delta","params":{"threadId":"TH","turnId":"T1","itemId":"m","delta":"Hello"}}'
echo '{"method":"turn/completed","params":{"threadId":"TH","turn":{"id":"T1","status":"completed","items":[]}}}'"#;

    fn session_folders(state: &AgentState) -> usize {
        std::fs::read_dir(&state.sessions_dir)
            .map(|d| d.count())
            .unwrap_or(0)
    }

    fn no_text(_: Update) {}

    #[tokio::test]
    async fn a_session_runs_a_turn_and_close_deletes_its_folder() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        assert_eq!(session_folders(&state), 1);
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        assert!(scratch.join("AGENTS.md").is_file());
        std::fs::write(scratch.join("app.html"), "<p>x</p>").unwrap();

        let seen = Arc::new(StdMutex::new(String::new()));
        let s2 = seen.clone();
        let mut on = move |u: Update| {
            if let Update::Text { text, .. } = u {
                s2.lock().unwrap().push_str(text)
            }
        };
        let out = chat_send_with(&state, "make a timer", &mut on, Limits::default())
            .await
            .unwrap();
        assert_eq!(out.status, chat::TurnStatus::Completed);
        assert_eq!(out.draft.unwrap().size, 8);
        assert_eq!(seen.lock().unwrap().as_str(), "Hello");
        assert!(!state.turn_running.load(Ordering::SeqCst));

        chat_close_with(&state).await;
        assert!(!scratch.exists());
        assert!(state.chat.lock().await.is_none());
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_session_needs_a_sign_in_and_leaves_no_folder_without_one() {
        let (state, d) = with_program(&chat_script(false, FINISH));
        let e = chat_start_with(&state).await.unwrap_err();
        assert_eq!(e.code, "not_signed_in");
        assert_eq!(session_folders(&state), 0);
        assert!(state.chat.lock().await.is_none());
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn sending_needs_an_open_session_and_a_real_message() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        let e = chat_send_with(&state, "hi", &mut no_text, Limits::default())
            .await
            .unwrap_err();
        assert_eq!(e.code, "no_session");
        chat_start_with(&state).await.unwrap();
        let e = chat_send_with(&state, "   ", &mut no_text, Limits::default())
            .await
            .unwrap_err();
        assert_eq!(e.code, "bad_prompt");
        // Nothing was sent to Codex for the bad message: the next real one still works.
        let out = chat_send_with(&state, "ok", &mut no_text, Limits::default())
            .await
            .unwrap();
        assert_eq!(out.status, chat::TurnStatus::Completed);
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_second_message_while_one_runs_is_refused() {
        let (state, d) = with_program(&chat_script(true, "sleep 3"));
        chat_start_with(&state).await.unwrap();
        state.turn_running.store(true, Ordering::SeqCst);
        let e = chat_send_with(&state, "again", &mut no_text, Limits::default())
            .await
            .unwrap_err();
        assert_eq!(e.code, "busy");
        let e = chat_start_with(&state).await.unwrap_err();
        assert_eq!(e.code, "busy");
        // The refusal must not clear the flag the running turn owns.
        assert!(state.turn_running.load(Ordering::SeqCst));
        state.turn_running.store(false, Ordering::SeqCst);
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_process_that_dies_mid_turn_ends_the_session_and_removes_its_folder() {
        let (state, d) = with_program(&chat_script(true, "exit 0"));
        chat_start_with(&state).await.unwrap();
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        let e = chat_send_with(&state, "go", &mut no_text, Limits::default())
            .await
            .unwrap_err();
        assert_eq!(e.code, "process");
        assert!(state.chat.lock().await.is_none());
        assert!(!scratch.exists());
        assert!(!state.turn_running.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn quitting_deletes_every_work_folder() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        assert_eq!(session_folders(&state), 1);
        state.shutdown().await;
        assert!(!state.sessions_dir.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── Previews ──

    #[tokio::test]
    async fn a_preview_is_a_private_copy_of_the_draft() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        let e = preview_draft_with(&state).await.unwrap_err();
        assert_eq!(e.code, "no_draft");
        std::fs::write(scratch.join("app.html"), "<p>v1</p>").unwrap();
        let (id, dir, sha) = preview_draft_with(&state).await.unwrap();
        assert_eq!(dir, state.previews_dir.join(&id));
        assert_eq!(std::fs::read(dir.join("index.html")).unwrap(), b"<p>v1</p>");
        assert_eq!(sha, hex::encode(sha2::Sha256::digest(b"<p>v1</p>")));
        // The agent changing its file later does not change what the window shows.
        std::fs::write(scratch.join("app.html"), "<p>v2</p>").unwrap();
        assert_eq!(std::fs::read(dir.join("index.html")).unwrap(), b"<p>v1</p>");
        // A second preview is its own copy.
        let (id2, dir2, _) = preview_draft_with(&state).await.unwrap();
        assert_ne!(id, id2);
        assert_eq!(
            std::fs::read(dir2.join("index.html")).unwrap(),
            b"<p>v2</p>"
        );
        state.shutdown().await;
        assert!(!state.previews_dir.exists(), "quitting removes the copies");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_preview_needs_a_session_and_refuses_a_link_or_an_oversized_draft() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        let e = preview_draft_with(&state).await.unwrap_err();
        assert_eq!(e.code, "no_session");
        chat_start_with(&state).await.unwrap();
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        let secret = d.join("secret.txt");
        std::fs::write(&secret, "private").unwrap();
        std::os::unix::fs::symlink(&secret, scratch.join("app.html")).unwrap();
        assert_eq!(
            preview_draft_with(&state).await.unwrap_err().code,
            "no_draft"
        );
        std::fs::remove_file(scratch.join("app.html")).unwrap();
        std::fs::write(
            scratch.join("app.html"),
            vec![b'a'; chat::MAX_DRAFT_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(
            preview_draft_with(&state).await.unwrap_err().code,
            "draft_too_large"
        );
        assert!(
            !state.previews_dir.exists()
                || std::fs::read_dir(&state.previews_dir).unwrap().count() == 0
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn only_so_many_previews_can_be_open() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        std::fs::write(scratch.join("app.html"), "<p>x</p>").unwrap();
        for _ in 0..MAX_PREVIEWS {
            preview_draft_with(&state).await.unwrap();
        }
        assert_eq!(
            preview_draft_with(&state).await.unwrap_err().code,
            "too_many_previews"
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── Adding a draft ──

    async fn pool_in(d: &Path) -> sqlx::SqlitePool {
        let pool = crate::db::create_pool(d).await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn write_draft(state: &AgentState, html: &str) {
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        std::fs::write(scratch.join("app.html"), html).unwrap();
    }

    const PAGE1: &str = "<html><head><title>Timer</title></head><body>one</body></html>";
    const PAGE2: &str = "<html><head><title>Timer</title></head><body>two</body></html>";

    #[tokio::test]
    async fn a_draft_is_scanned_added_and_then_saved_as_new_versions() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        let pool = pool_in(&d).await;
        chat_start_with(&state).await.unwrap();
        assert_eq!(
            scan_draft_with(&state, &pool).await.unwrap_err().code,
            "no_draft"
        );
        write_draft(&state, PAGE1).await;
        let r = scan_draft_with(&state, &pool).await.unwrap();
        assert_eq!(
            (r.name.as_str(), r.saves_as),
            ("Timer", draft::SavesAs::New)
        );

        let a = add_draft_with(&state, &pool, &d).await.unwrap();
        assert_eq!(a.outcome, draft::AddOutcome::Added);
        assert_eq!(a.tool.origin.as_deref(), Some("agent"));
        assert!(a.tool.approvals.is_empty());

        // Codex changes the page: the report now offers a new version of the same tool.
        write_draft(&state, PAGE2).await;
        let r = scan_draft_with(&state, &pool).await.unwrap();
        assert_eq!(
            (r.saves_as, r.tool_name.as_deref()),
            (draft::SavesAs::Version, Some("Timer"))
        );
        let b = add_draft_with(&state, &pool, &d).await.unwrap();
        assert_eq!(
            (b.outcome, b.version_num),
            (draft::AddOutcome::NewVersion, 2)
        );
        assert_eq!(b.tool.id, a.tool.id);
        // Adding the same thing again changes nothing.
        let c = add_draft_with(&state, &pool, &d).await.unwrap();
        assert_eq!(c.outcome, draft::AddOutcome::Unchanged);

        // A new session starts fresh: its first draft is a new tool, not a version of the old one.
        // (A fresh process answers the new start; the stand-in serves one session per process.)
        state.stop().await;
        chat_start_with(&state).await.unwrap();
        write_draft(
            &state,
            "<html><head><title>Other</title></head><body>x</body></html>",
        )
        .await;
        assert_eq!(
            scan_draft_with(&state, &pool).await.unwrap().saves_as,
            draft::SavesAs::New
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn adding_needs_a_session_and_a_plain_text_draft_and_changes_nothing_otherwise() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        let pool = pool_in(&d).await;
        assert_eq!(
            add_draft_with(&state, &pool, &d).await.unwrap_err().code,
            "no_session"
        );
        chat_start_with(&state).await.unwrap();
        assert_eq!(
            add_draft_with(&state, &pool, &d).await.unwrap_err().code,
            "no_draft"
        );
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        std::fs::write(scratch.join("app.html"), [0xffu8, 0xfe, 0x00]).unwrap();
        assert_eq!(
            add_draft_with(&state, &pool, &d).await.unwrap_err().code,
            "draft_not_text"
        );
        std::fs::remove_file(scratch.join("app.html")).unwrap();
        let secret = d.join("secret.txt");
        std::fs::write(&secret, "<p>private</p>").unwrap();
        std::os::unix::fs::symlink(&secret, scratch.join("app.html")).unwrap();
        assert_eq!(
            add_draft_with(&state, &pool, &d).await.unwrap_err().code,
            "no_draft"
        );
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tools")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "nothing was added");
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn starting_a_new_session_replaces_the_old_one() {
        // Two threads need two scripted answers, so the second start is checked on folders only.
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        let first = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        state.chat.lock().await.take();
        std::fs::create_dir_all(state.sessions_dir.join("left-over")).unwrap();
        state.stop().await;
        // A fresh process answers the new start; the old folder and the left-over are gone.
        chat_start_with(&state).await.unwrap();
        assert!(!first.exists());
        assert!(!state.sessions_dir.join("left-over").exists());
        assert_eq!(session_folders(&state), 1);
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── Going back to an earlier draft ──

    const PAGE3: &str = "<html><head><title>Timer</title></head><body>three</body></html>";

    fn current_file(state: &AgentState) -> String {
        let scratch = state
            .chat
            .try_lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .scratch
            .clone();
        std::fs::read_to_string(scratch.join("app.html")).unwrap()
    }

    #[tokio::test]
    async fn every_draft_is_kept_and_an_earlier_one_can_be_put_back() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        assert!(history_with(&state).await.unwrap().is_empty());

        write_draft(&state, PAGE1).await;
        chat_send_with(&state, "make a timer", &mut no_text, Limits::default())
            .await
            .unwrap();
        // A later file is seen the next time the list is asked for.
        write_draft(&state, PAGE2).await;
        let list = history_with(&state).await.unwrap();
        assert_eq!(list.iter().map(|e| e.number).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(
            list.iter().map(|e| e.current).collect::<Vec<_>>(),
            [true, false]
        );
        let first = list[1].sha.clone();

        // Going back writes the old file over app.html and keeps the list as it was.
        let back = restore_with(&state, &first).await.unwrap();
        assert_eq!(back.size, PAGE1.len() as u64);
        assert_eq!(current_file(&state), PAGE1);
        let list = history_with(&state).await.unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[1].current && !list[0].current);

        // A draft that was never listed is kept before it is written over, so going back
        // never loses work.
        write_draft(&state, PAGE3).await;
        restore_with(&state, &list[0].sha).await.unwrap();
        assert_eq!(current_file(&state), PAGE2);
        assert_eq!(history_with(&state).await.unwrap().len(), 3);

        assert_eq!(
            restore_with(&state, "nope").await.unwrap_err().code,
            "no_draft"
        );
        state.turn_running.store(true, Ordering::SeqCst);
        assert_eq!(restore_with(&state, &first).await.unwrap_err().code, "busy");
        state.turn_running.store(false, Ordering::SeqCst);
        assert_eq!(
            current_file(&state),
            PAGE2,
            "a refused restore changes nothing"
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn an_earlier_draft_can_be_previewed_without_putting_it_back() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        chat_start_with(&state).await.unwrap();
        write_draft(&state, PAGE1).await;
        let first = history_with(&state).await.unwrap()[0].sha.clone();
        write_draft(&state, PAGE2).await;
        let (_, dir, sha) = preview_version_with(&state, Some(&first)).await.unwrap();
        assert_eq!(sha, first);
        assert_eq!(
            std::fs::read_to_string(dir.join("index.html")).unwrap(),
            PAGE1
        );
        assert_eq!(current_file(&state), PAGE2);
        assert_eq!(
            preview_version_with(&state, Some("nope"))
                .await
                .unwrap_err()
                .code,
            "no_draft"
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn codex_is_told_once_that_an_earlier_draft_was_put_back() {
        let out = std::env::temp_dir().join(format!("sanctum-turn-{}", uuid::Uuid::new_v4()));
        let script = String::from_utf8(chat_script(true, FINISH))
            .unwrap()
            .replacen(
                "read line\necho '{\"id\":4",
                &format!(
                    "read line\nprintf '%s' \"$line\" > '{}'\necho '{{\"id\":4",
                    out.display()
                ),
                1,
            );
        let (state, d) = with_program(script.as_bytes());
        chat_start_with(&state).await.unwrap();
        write_draft(&state, PAGE1).await;
        let first = history_with(&state).await.unwrap()[0].sha.clone();
        write_draft(&state, PAGE2).await;
        restore_with(&state, &first).await.unwrap();
        chat_send_with(&state, "make it blue", &mut no_text, Limits::default())
            .await
            .unwrap();
        let sent = std::fs::read_to_string(&out).unwrap();
        assert!(
            sent.contains("put an earlier version of app.html back"),
            "{sent}"
        );
        assert!(sent.contains("make it blue"));
        let session = state.chat.lock().await.clone().unwrap();
        assert!(!session.restored.load(Ordering::SeqCst), "told once");
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_file(&out);
    }

    // ── Standing instructions and starting from an app ──

    #[test]
    fn instructions_are_saved_cleaned_bounded_and_removable() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        assert_eq!(read_instructions(&state), "");
        assert_eq!(
            write_instructions(
                &state,
                "  Save files to Downloads.\u{0}\u{7}\nKeep it small.  "
            )
            .unwrap(),
            "Save files to Downloads.\nKeep it small."
        );
        assert_eq!(
            read_instructions(&state),
            "Save files to Downloads.\nKeep it small."
        );
        let too_long = "a".repeat(chat::MAX_INSTRUCTIONS_CHARS + 1);
        assert_eq!(
            write_instructions(&state, &too_long).unwrap_err().code,
            "bad_instructions"
        );
        assert!(write_instructions(&state, &"a".repeat(chat::MAX_INSTRUCTIONS_CHARS)).is_ok());
        assert_eq!(write_instructions(&state, "  \n ").unwrap(), "");
        assert!(!state.instructions_path.exists());
        assert_eq!(
            write_instructions(&state, "").unwrap(),
            "",
            "removing nothing is fine"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_session_reads_the_standing_instructions() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        let text = "Always show a Saved message after a download.";
        write_instructions(&state, text).unwrap();
        let started = chat_start_with(&state).await.unwrap();
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        let rules = std::fs::read_to_string(scratch.join("AGENTS.md")).unwrap();
        assert!(rules.contains("Always show a Saved message after a download."));
        assert!(rules.contains("The rules above always win"));
        let kinds: Vec<_> = started.sources.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["guide", "instructions"]);
        assert_eq!(
            started.sources[1].detail,
            format!("{} characters.", text.chars().count())
        );
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_session_can_start_from_an_app_in_the_library() {
        let (state, d) = with_program(&chat_script(true, FINISH));
        let pool = pool_in(&d).await;
        // Someone else's page, added the ordinary way: it keeps no agent mark.
        let ours = crate::commands::ingest::ingest_html_inner(&pool, &d, PAGE1, Some("timer.html"))
            .await
            .unwrap();
        let added = draft::Added {
            outcome: draft::AddOutcome::Added,
            tool: ours.tool,
            version_num: 1,
        };
        let src = draft::load_source(&pool, &d, &added.tool.id).await.unwrap();
        assert_eq!((src.name.as_str(), src.version_num), ("Timer", 1));

        let started = chat_start_from_with(&state, Some(src)).await.unwrap();
        let kinds: Vec<_> = started.sources.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["app", "guide", "instructions"]);
        assert_eq!(
            started.sources[0].tool_id.as_deref(),
            Some(added.tool.id.as_str())
        );
        assert!(started.sources[0].detail.contains("goes to OpenAI"));
        assert_eq!(current_file(&state), PAGE1);
        let scratch = state.chat.lock().await.as_ref().unwrap().scratch.clone();
        let rules = std::fs::read_to_string(scratch.join("AGENTS.md")).unwrap();
        assert!(rules.contains("`app.html` in this folder is the current version of \"Timer\""));

        // It is the first draft, and a change is offered as a new version of that app.
        let list = history_with(&state).await.unwrap();
        assert_eq!(
            (list.len(), list[0].loaded, list[0].current),
            (1, true, true)
        );
        write_draft(&state, PAGE2).await;
        let r = scan_draft_with(&state, &pool).await.unwrap();
        assert_eq!(
            (r.saves_as, r.tool_name.as_deref()),
            (draft::SavesAs::Version, Some("Timer"))
        );
        let b = add_draft_with(&state, &pool, &d).await.unwrap();
        assert_eq!(
            (b.outcome, b.version_num, b.tool.id.as_str()),
            (draft::AddOutcome::NewVersion, 2, added.tool.id.as_str())
        );
        assert_eq!(b.tool.origin, None, "an app that was yours stays yours");
        // Going back to the starting point is one click.
        restore_with(&state, &list[0].sha).await.unwrap();
        assert_eq!(current_file(&state), PAGE1);
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod window_rules {
    use super::*;

    #[test]
    fn only_sanctums_own_windows_may_use_the_agent_commands() {
        assert!(is_host_label("main"));
        assert!(is_host_label(CREATE_WINDOW));
        // Tool windows run other people's code. They get nothing.
        assert!(!is_host_label("tool-1234"));
        assert!(!is_host_label("tool-main"));
        assert!(!is_host_label("create2"));
        assert!(!is_host_label("Main"));
        assert!(!is_host_label(""));
    }

    fn capability(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("capabilities")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn the_create_window_has_its_own_small_capability_and_tool_windows_stay_empty() {
        let c = capability("create.json");
        assert_eq!(c["windows"], serde_json::json!([CREATE_WINDOW]));
        let perms: Vec<&str> = c["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        assert_eq!(
            perms,
            ["core:default", "clipboard-manager:allow-write-text"]
        );
        // The main window's capability does not name it, and tool windows have none at all.
        assert_eq!(
            capability("main.json")["windows"],
            serde_json::json!(["main"])
        );
        let t = capability("tool-default.json");
        assert_eq!(t["windows"], serde_json::json!(["tool-*"]));
        assert_eq!(t["permissions"], serde_json::json!([]));
    }

    /// `agent_preview_draft` needs a live Tauri window, so its ordering cannot be run here. This
    /// pins that the organisation policy is consulted with the copy's hash before the window is
    /// opened. Removing or moving the check fails this test.
    #[test]
    fn the_org_policy_is_checked_before_a_draft_window_opens() {
        let src = include_str!("commands.rs");
        let body = &src[src.find("pub async fn agent_preview_draft").unwrap()..];
        let check = body
            .find("crate::policy::check_run(&crate::policy::load(), &sha)")
            .expect("the policy check");
        let open = body.find("open_draft_window").expect("window creation");
        assert!(check < open, "the policy check must come first");
    }
}
