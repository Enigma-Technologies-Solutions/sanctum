// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Tauri commands for the agent: is it set up, who is signed in, sign in, cancel, sign out.
//!
//! Every command runs only when the person clicks something in the main window. Codex is
//! downloaded (see [`super::install`]) only when they choose to sign in, and the `codex`
//! process starts on the first command that needs it, never at launch. It stops when Sanctum
//! quits. Tool windows have no IPC; each command also checks the window label.
//!
//! Text that came from the agent (an error message, an email address) is cleaned again in
//! `src/lib/commands.ts` before it is shown.

use super::account::{self, Status, SIGN_IN_TIMEOUT};
use super::install::{self, InstallError, Release};
use super::process::AgentProcess;
use super::AgentError;
use crate::registry::fetch::Transport;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Window};
use tokio::sync::Mutex;

/// Event the main window listens for while Codex downloads.
pub const DOWNLOAD_EVENT: &str = "agent-download";

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
    process: Mutex<Option<Arc<AgentProcess>>>,
    signing_in: AtomicBool,
    cancelled: AtomicBool,
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
        AgentState {
            home: data_dir.join("agent").join("codex-home"),
            bin_dir: data_dir.join("agent").join("bin"),
            version: version.to_owned(),
            release,
            transport,
            program_override: debug_override(),
            process: Mutex::new(None),
            signing_in: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
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

    /// Called when Sanctum quits.
    pub async fn shutdown(&self) {
        self.stop().await;
    }
}

/// What the interface needs to decide what to show.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetup {
    /// Sanctum has a Codex build for this computer.
    pub supported: bool,
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

fn require_main(window: &Window) -> Result<(), AgentCommandError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(AgentCommandError::new(
            "forbidden",
            "This is only available in the main window.",
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
        installed: state.installed(),
        download_mb: state
            .release
            .as_ref()
            .map_or(0, |r| r.pin.archive_size.div_ceil(1_000_000)),
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

// ── The commands ──────────────────────────────────────────────────────────────────────────────

/// Whether Sanctum can set up the agent here and whether it already has. Looks at files only.
#[tauri::command]
pub fn agent_setup(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentSetup, AgentCommandError> {
    require_main(&window)?;
    Ok(setup_of(&state))
}

/// The signed-in account. Starts the local Codex process if it is not running; no request
/// leaves the computer for this. Does not download anything.
#[tauri::command]
pub async fn agent_account(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentAccount, AgentCommandError> {
    require_main(&window)?;
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
    require_main(&window)?;
    let emit = move |done: u64, total: u64| {
        let _ = app.emit_to("main", DOWNLOAD_EVENT, DownloadProgress { done, total });
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
    require_main(&window)?;
    cancel_with(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn agent_sign_out(
    window: Window,
    state: State<'_, AgentState>,
) -> Result<AgentAccount, AgentCommandError> {
    require_main(&window)?;
    sign_out_with(&state).await
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
        st.program_override = None;
        (st, d, mock)
    }

    #[tokio::test]
    async fn the_first_sign_in_downloads_codex_then_signs_in() {
        let (state, d, mock) = with_download(&fake_script(false));
        assert_eq!(
            setup_of(&state),
            AgentSetup {
                supported: true,
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
        state.program_override = None;
        assert_eq!(
            setup_of(&state),
            AgentSetup {
                supported: false,
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
}
