// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Starting and stopping `codex app-server`.
//!
//! The child gets a cleared environment plus a short allowlist, and its own `CODEX_HOME`.
//! Clearing matters: a user's `OPENAI_API_KEY` or `CODEX_*` variables must not change which
//! account, config or sandbox the agent uses.

use super::protocol::{initialize_params, M_INITIALIZE, N_INITIALIZED};
use super::rpc::Rpc;
use super::AgentError;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// How much of the child's stderr is kept (the most recent part).
const STDERR_KEEP: usize = 16 * 1024;

/// Variables passed through from Sanctum's own environment. Everything else is dropped.
/// Proxy settings are kept so a company network still works.
const PASS_THROUGH: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    // Windows needs these for a process to start and find its profile.
    "SystemRoot",
    "SYSTEMROOT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "COMSPEC",
    "PATHEXT",
];

/// The environment for the child, from `vars` (normally `std::env::vars()`).
pub fn child_env(
    codex_home: &Path,
    vars: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vars
        .into_iter()
        .filter(|(k, _)| PASS_THROUGH.contains(&k.as_str()))
        .collect();
    out.push((
        "CODEX_HOME".into(),
        codex_home.to_string_lossy().into_owned(),
    ));
    out
}

pub struct AgentProcess {
    pub rpc: Rpc,
    child: tokio::sync::Mutex<Child>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
}

impl AgentProcess {
    /// Starts the process and completes the protocol handshake.
    pub async fn start(
        binary: &Path,
        codex_home: &Path,
        version: &str,
    ) -> Result<AgentProcess, AgentError> {
        std::fs::create_dir_all(codex_home)
            .map_err(|e| AgentError::Spawn(format!("cannot create the agent folder: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(codex_home, std::fs::Permissions::from_mode(0o700));
        }

        let mut cmd = Command::new(binary);
        cmd.arg("app-server")
            .env_clear()
            .envs(child_env(codex_home, std::env::vars()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd
            .spawn()
            .map_err(|e| AgentError::Spawn(format!("cannot start the agent: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::Spawn("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Spawn("no stdout".into()))?;
        let mut stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::Spawn("no stderr".into()))?;

        let stderr: Arc<Mutex<VecDeque<u8>>> = Arc::new(Mutex::new(VecDeque::new()));
        let keep = stderr.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr_pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut q = keep.lock().unwrap();
                q.extend(&buf[..n]);
                while q.len() > STDERR_KEEP {
                    q.pop_front();
                }
            }
        });

        let rpc = Rpc::start(stdout, stdin);
        let proc = AgentProcess {
            rpc,
            child: tokio::sync::Mutex::new(child),
            stderr,
        };
        let init = proc
            .rpc
            .request(
                M_INITIALIZE,
                initialize_params(version),
                super::account::REQUEST_TIMEOUT,
            )
            .await;
        if let Err(e) = init {
            proc.shutdown().await;
            return Err(e.into());
        }
        proc.rpc.notify(N_INITIALIZED, serde_json::json!({}))?;
        Ok(proc)
    }

    /// The end of what the process wrote to stderr, for the "Copy details" button.
    pub fn stderr_tail(&self) -> String {
        let q = self.stderr.lock().unwrap();
        let bytes: Vec<u8> = q.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Stops the process. Takes `&self` so it can be called while another task is waiting on
    /// the connection (the waiting task then sees the connection close).
    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn the_child_environment_is_an_allowlist_with_our_codex_home() {
        let env = child_env(
            Path::new("/data/agent/codex-home"),
            vars(&[
                ("PATH", "/usr/bin"),
                ("HOME", "/Users/x"),
                ("HTTPS_PROXY", "http://proxy:3128"),
                ("OPENAI_API_KEY", "sk-secret"),
                ("CODEX_HOME", "/Users/x/.codex"),
                ("CODEX_SANDBOX", "x"),
                ("ANTHROPIC_API_KEY", "k"),
                ("AWS_SECRET_ACCESS_KEY", "s"),
            ]),
        );
        let get = |k: &str| {
            env.iter()
                .filter(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(get("PATH"), ["/usr/bin"]);
        assert_eq!(get("HTTPS_PROXY"), ["http://proxy:3128"]);
        // Exactly one CODEX_HOME, and it is ours, not the user's.
        assert_eq!(get("CODEX_HOME"), ["/data/agent/codex-home"]);
        for secret in [
            "OPENAI_API_KEY",
            "CODEX_SANDBOX",
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(get(secret).is_empty(), "{secret} must not reach the agent");
        }
    }

    #[cfg(unix)]
    mod spawned {
        use super::super::*;
        use crate::agent::account;
        use std::os::unix::fs::PermissionsExt;

        /// A shell script standing in for `codex`. It answers the handshake and `account/read`,
        /// and prints its environment to stderr so the test can see what it was given.
        fn fake_codex(dir: &Path) -> std::path::PathBuf {
            let path = dir.join("codex");
            std::fs::write(
                &path,
                r#"#!/bin/sh
echo "args:$*" >&2
echo "home:$CODEX_HOME" >&2
echo "key:${OPENAI_API_KEY:-unset}" >&2
read line
echo '{"id":1,"result":{"userAgent":"fake"}}'
read line
read line
echo '{"id":2,"result":{"account":{"type":"chatgpt","email":"me@example.com","planType":"plus"},"requiresOpenaiAuth":true}}'
read line
"#,
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        #[tokio::test]
        async fn starts_a_process_completes_the_handshake_and_reads_the_account() {
            let dir =
                std::env::temp_dir().join(format!("sanctum-agent-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let bin = fake_codex(&dir);
            let home = dir.join("home");
            // The parent's secret must not reach the child.
            std::env::set_var("OPENAI_API_KEY", "sk-test-should-not-leak");

            let p = AgentProcess::start(&bin, &home, "0.0.0-test")
                .await
                .expect("start");
            let s = account::status(&p.rpc).await.expect("status");
            assert!(s.signed_in);
            assert_eq!(s.plan.as_deref(), Some("Plus"));

            // Give the stderr reader a moment to collect.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let err = p.stderr_tail();
            assert!(err.contains("args:app-server"), "{err}");
            assert!(err.contains(&format!("home:{}", home.display())), "{err}");
            assert!(err.contains("key:unset"), "{err}");

            #[cfg(unix)]
            {
                let mode = std::fs::metadata(&home).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o700);
            }
            p.shutdown().await;
            std::env::remove_var("OPENAI_API_KEY");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn a_missing_binary_is_a_clear_error() {
            let dir =
                std::env::temp_dir().join(format!("sanctum-agent-test-{}", uuid::Uuid::new_v4()));
            let r = AgentProcess::start(&dir.join("nope"), &dir.join("home"), "0").await;
            assert!(matches!(r, Err(AgentError::Spawn(_))));
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn a_process_that_exits_at_once_fails_the_handshake() {
            let dir =
                std::env::temp_dir().join(format!("sanctum-agent-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let bin = dir.join("codex");
            std::fs::write(&bin, "#!/bin/sh\nexit 3\n").unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let r = AgentProcess::start(&bin, &dir.join("home"), "0").await;
            assert!(matches!(r, Err(AgentError::Rpc(_))), "{:?}", r.err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
