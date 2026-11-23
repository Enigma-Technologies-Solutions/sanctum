// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Layer 2: Sanctum's own sandbox around the whole `codex app-server` process (macOS).
//!
//! Layer 1 is Codex's own sandbox for the commands the agent runs. It keeps writes in the work
//! folder and commands off the network, but lets them read most of the disk. Layer 2 runs the
//! app-server itself under a Seatbelt profile that Sanctum writes: reads only from system
//! folders, the Codex program, `CODEX_HOME` and the work folders; writes only to `CODEX_HOME` and
//! the work folders; network only to a proxy inside Sanctum.
//!
//! Findings this rests on (docs/create-app-plan.md, Phase 0):
//!
//! - Codex's own sandbox cannot start inside another one, so under Layer 2 each turn uses the
//!   `externalSandbox` policy and commands run under this profile alone.
//! - Commands therefore share the app-server's access to the proxy, and they inherit its
//!   environment. A secret in the proxy address would not help: a command can read the
//!   app-server's environment through the `KERN_PROCARGS2` sysctl, which no Seatbelt rule blocks.
//!   So the proxy accepts a connection only when the app-server process itself owns the
//!   connecting socket ([`pid_owns_connection`]), and only `CONNECT` to [`ALLOWED`].
//!
//! On for every macOS build. A development build can turn it off with `SANCTUM_OUTER_SANDBOX=0`
//! to compare against Codex's own sandbox alone. Building apps is not offered on other systems
//! yet (`install::OFFERED_ON`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The only places the app-server may reach, measured on 2026-11-14: chat turns go to
/// `chatgpt.com`, sign-in, sign-out and token refresh to `auth.openai.com`.
pub const ALLOWED: &[&str] = &["chatgpt.com:443", "auth.openai.com:443"];

/// The port Codex listens on for the browser's sign-in callback.
pub const SIGN_IN_PORT: u16 = 1455;

/// Longest `CONNECT` request head the proxy reads.
const MAX_HEAD: usize = 8 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Turned on only by the ignored live tests, which run the real Codex under the profile.
#[cfg(test)]
pub static LIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether Layer 2 is on: always on macOS, except in a development build started with
/// `SANCTUM_OUTER_SANDBOX=0`. A release build ignores the variable. Off in unit tests, whose
/// fake Codex scripts live in temporary folders the profile does not open; the profile and the
/// proxy have their own tests, and `live_layer_2` runs the real Codex under them.
pub fn active() -> bool {
    #[cfg(test)]
    {
        LIVE.load(std::sync::atomic::Ordering::SeqCst)
    }
    #[cfg(all(not(test), debug_assertions, target_os = "macos"))]
    {
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ON.get_or_init(|| std::env::var_os("SANCTUM_OUTER_SANDBOX").is_none_or(|v| v != "0"))
    }
    #[cfg(all(not(test), not(debug_assertions), target_os = "macos"))]
    {
        true
    }
    #[cfg(all(not(test), not(target_os = "macos")))]
    {
        false
    }
}

// ── The proxy ────────────────────────────────────────────────────────────────────────────────

/// Decides whether a connection to the proxy may be served: `(app_pid, client_port, proxy_port)`.
pub type OwnerCheck = fn(u32, u16, u16) -> bool;

/// A `CONNECT` proxy on `127.0.0.1` for the sandboxed app-server.
pub struct Proxy {
    port: u16,
    app_pid: Arc<AtomicU32>,
    task: tokio::task::JoinHandle<()>,
}

impl Proxy {
    /// Listens on a free port. Nothing is served until [`Proxy::set_app_pid`] names the process.
    pub async fn start(check: OwnerCheck) -> std::io::Result<Proxy> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let app_pid = Arc::new(AtomicU32::new(0));
        let pid = app_pid.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, peer)) = listener.accept().await {
                let want = pid.load(Ordering::SeqCst);
                tokio::spawn(async move {
                    if want == 0 || !check(want, peer.port(), port) {
                        note(&format!(
                            "refused a connection not made by Codex (port {})",
                            peer.port()
                        ));
                        return;
                    }
                    serve(stream).await;
                });
            }
        });
        Ok(Proxy {
            port,
            app_pid,
            task,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The process allowed to use the proxy. Set after each start of the app-server.
    pub fn set_app_pid(&self, pid: u32) {
        self.app_pid.store(pid, Ordering::SeqCst);
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Development builds: one line per decision, host and port only.
fn note(line: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[outer] {line}");
    #[cfg(not(debug_assertions))]
    let _ = line;
}

/// The target of a `CONNECT` request head, if it is one and is allowed.
pub fn allowed_target(head: &[u8]) -> Result<String, &'static str> {
    let text = std::str::from_utf8(head).map_err(|_| "not text")?;
    let first = text.split("\r\n").next().unwrap_or_default();
    let mut parts = first.split(' ');
    let (method, target, version) = (parts.next(), parts.next(), parts.next());
    if method != Some("CONNECT") {
        return Err("not CONNECT");
    }
    if !matches!(version, Some("HTTP/1.1" | "HTTP/1.0")) || parts.next().is_some() {
        return Err("malformed");
    }
    let target = target.unwrap_or_default().to_ascii_lowercase();
    if ALLOWED.contains(&target.as_str()) {
        Ok(target)
    } else {
        Err("host not allowed")
    }
}

async fn serve(mut client: TcpStream) {
    let mut buf = Vec::with_capacity(1024);
    let head_end = tokio::time::timeout(HEAD_TIMEOUT, async {
        let mut chunk = [0u8; 1024];
        loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                return Some(i + 4);
            }
            if buf.len() >= MAX_HEAD {
                return None;
            }
            match client.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await;
    let Ok(Some(end)) = head_end else { return };
    let target = match allowed_target(&buf[..end]) {
        Ok(t) => t,
        Err(why) => {
            let first = String::from_utf8_lossy(&buf[..end]);
            let first = first.split("\r\n").next().unwrap_or_default();
            let shown: String = first.chars().take(120).collect();
            note(&format!("refused ({why}): {shown}"));
            let _ = client
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            return;
        }
    };
    let upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&target)).await;
    let Ok(Ok(mut upstream)) = upstream else {
        note(&format!("could not reach {target}"));
        let _ = client
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await;
        return;
    };
    note(&format!("CONNECT {target}"));
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    // Anything the client sent after the head belongs to the tunnel.
    if end < buf.len() && upstream.write_all(&buf[end..]).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

// ── Who owns a connection ────────────────────────────────────────────────────────────────────

/// Whether process `pid` holds the client end of a TCP connection from `client_port` to
/// `proxy_port` on this machine. A command the agent runs is a different process, so its
/// connections fail this check even though the sandbox lets it reach the proxy.
#[cfg(target_os = "macos")]
pub fn pid_owns_connection(pid: u32, client_port: u16, proxy_port: u16) -> bool {
    use std::os::raw::{c_int, c_void};

    const PROC_PIDLISTFDS: c_int = 1;
    const PROC_PIDFDSOCKETINFO: c_int = 3;
    const PROX_FDTYPE_SOCKET: u32 = 2;
    // `struct socket_fdinfo` from <sys/proc_info.h>: `proc_fileinfo` (24 bytes), then
    // `socket_info`, whose `soi_kind` is at 232 and whose protocol union starts at 240 with
    // `insi_fport` and `insi_lport` (ports in network order in the low 16 bits).
    const SOCKET_FDINFO_SIZE: usize = 792;
    const OFF_KIND: usize = 24 + 232;
    const OFF_FPORT: usize = 24 + 240;
    const OFF_LPORT: usize = 24 + 244;
    const SOCKINFO_IN: i32 = 1;
    const SOCKINFO_TCP: i32 = 2;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ProcFdInfo {
        fd: i32,
        fdtype: u32,
    }
    #[repr(C, align(8))]
    struct SocketFdInfo([u8; SOCKET_FDINFO_SIZE]);

    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buf: *mut c_void,
            size: c_int,
        ) -> c_int;
        fn proc_pidfdinfo(
            pid: c_int,
            fd: c_int,
            flavor: c_int,
            buf: *mut c_void,
            size: c_int,
        ) -> c_int;
    }

    let Ok(pid) = c_int::try_from(pid) else {
        return false;
    };
    // SAFETY: a null buffer asks for the size needed.
    let need = unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return false;
    }
    let slots = need as usize / std::mem::size_of::<ProcFdInfo>() + 16;
    let mut fds = vec![ProcFdInfo { fd: 0, fdtype: 0 }; slots];
    let bytes = (slots * std::mem::size_of::<ProcFdInfo>()) as c_int;
    // SAFETY: `fds` holds `bytes` bytes of plain integers.
    let got = unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), bytes) };
    if got <= 0 {
        return false;
    }
    let count = got as usize / std::mem::size_of::<ProcFdInfo>();
    let read_i32 = |b: &[u8], off: usize| i32::from_ne_bytes(b[off..off + 4].try_into().unwrap());
    let port = |v: i32| u16::from_be(v as u16);
    for f in fds
        .iter()
        .take(count)
        .filter(|f| f.fdtype == PROX_FDTYPE_SOCKET)
    {
        let mut info = SocketFdInfo([0; SOCKET_FDINFO_SIZE]);
        // SAFETY: `info` is exactly the size the kernel fills for this flavor.
        let n = unsafe {
            proc_pidfdinfo(
                pid,
                f.fd,
                PROC_PIDFDSOCKETINFO,
                info.0.as_mut_ptr().cast(),
                SOCKET_FDINFO_SIZE as c_int,
            )
        };
        if n as usize != SOCKET_FDINFO_SIZE {
            continue;
        }
        let kind = read_i32(&info.0, OFF_KIND);
        if kind != SOCKINFO_TCP && kind != SOCKINFO_IN {
            continue;
        }
        if port(read_i32(&info.0, OFF_LPORT)) == client_port
            && port(read_i32(&info.0, OFF_FPORT)) == proxy_port
        {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
pub fn pid_owns_connection(_pid: u32, _client_port: u16, _proxy_port: u16) -> bool {
    false
}

// ── The Seatbelt profile ─────────────────────────────────────────────────────────────────────

/// The folders the profile names. All must be real paths (no symbolic links), because
/// Seatbelt matches the resolved path: `/var/...` is `/private/var/...` to it.
pub struct Folders {
    /// Where the Codex program lives (read only).
    pub program: PathBuf,
    /// Codex's own folder (read and write).
    pub codex_home: PathBuf,
    /// The work folders of build sessions (read and write).
    pub sessions: PathBuf,
}

/// A string literal in the profile language.
fn quoted(p: &Path) -> String {
    let s = p.to_string_lossy();
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The system services the app-server and its commands may contact, measured on 2026-11-18
/// with Codex 0.163.0 by logging every lookup: user and group lookups, notifications, logging,
/// and certificate checks for Codex's own TLS (`trustd`, `SecurityServer`). Everything else is refused. That matters: with
/// every service open, `open` (Launch Services) and `osascript` (Apple events) start programs
/// outside the sandbox, such as a browser with a URL carrying data, and `pbpaste` reads the
/// clipboard. Refused lookups seen in normal use and harmless: analytics, diagnostics,
/// `configd`, FSEvents and the Launch Services database.
pub const MACH_SERVICES: &[&str] = &[
    "com.apple.system.notification_center",
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.system.opendirectoryd.membership",
    "com.apple.logd",
    "com.apple.system.logger",
    "com.apple.trustd.agent",
    // Codex checks the certificate of its own connections through it; without it every request
    // fails ("workspace routing discovery failed" on reading the account). The keychains
    // themselves stay closed: their files are outside every folder the profile opens, and
    // `live_layer_2` checks that `security` cannot list or read them.
    "com.apple.SecurityServer",
];

/// The profile. Deny by default; see the module comment for what each part is for.
pub fn profile(f: &Folders, proxy_port: u16) -> String {
    let home = quoted(&f.codex_home);
    let sessions = quoted(&f.sessions);
    let program = quoted(&f.program);
    let config = quoted(&f.codex_home.join("config.toml"));
    let agents = quoted(&f.codex_home.join("AGENTS.md"));
    // Files Codex reads at start that a command could use to act in later sessions: variables
    // (`.env`) and hooks, which run commands on events. They would still run in here, but they
    // would outlast the conversation that planted them.
    let dotenv = quoted(&f.codex_home.join(".env"));
    let hooks_file = quoted(&f.codex_home.join("hooks.json"));
    let hooks_dir = quoted(&f.codex_home.join("hooks"));
    let mach = MACH_SERVICES
        .iter()
        .map(|n| format!("\"{n}\""))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup (global-name {mach}))
(allow ipc-posix-shm)
(allow file-read-metadata)
(allow file-read*
  (literal "/")
  (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System")
  (subpath "/Library/Apple") (subpath "/Library/Preferences")
  (subpath "/Library/Developer/CommandLineTools") (subpath "/Applications/Xcode.app")
  (subpath "/private/etc") (subpath "/private/var/db/timezone")
  (literal "/private/var/db/xcode_select_link") (subpath "/private/var/select")
  (subpath "/dev")
  (subpath {program}) (subpath {home}) (subpath {sessions}))
(allow file-write*
  (subpath {home}) (subpath {sessions})
  (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
(deny file-write* (literal {config}) (literal {agents}) (literal {dotenv})
  (literal {hooks_file}) (literal {hooks_dir}) (subpath {hooks_dir}))
(allow file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
(allow network-outbound (remote ip "localhost:{proxy_port}"))
(allow network-bind (local ip "localhost:{SIGN_IN_PORT}"))
(allow network-inbound (local ip "localhost:{SIGN_IN_PORT}"))
"#
    )
}

/// The program and arguments that start `binary app-server` under the profile.
pub fn wrapped_command(binary: &Path, profile: &str) -> (PathBuf, Vec<String>) {
    (
        PathBuf::from("/usr/bin/sandbox-exec"),
        vec![
            "-p".into(),
            profile.into(),
            binary.to_string_lossy().into_owned(),
            "app-server".into(),
        ],
    )
}

/// Environment changes for the sandboxed app-server: its proxy is Sanctum's, and its temporary
/// folder is inside `CODEX_HOME` (the system one is closed to it). Commands inherit these.
/// git stops with "unable to access '~/.gitconfig'" when the file exists but cannot be read,
/// so its global config points at an empty file; the user's own settings stay out of reach.
pub fn env_overrides(codex_home: &Path, proxy_port: u16) -> Vec<(String, String)> {
    let proxy = format!("http://127.0.0.1:{proxy_port}");
    vec![
        ("HTTPS_PROXY".into(), proxy.clone()),
        ("HTTP_PROXY".into(), proxy.clone()),
        ("https_proxy".into(), proxy.clone()),
        ("http_proxy".into(), proxy),
        (
            "TMPDIR".into(),
            format!("{}/", codex_home.join("tmp").to_string_lossy()),
        ),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
    ]
}

/// Variables removed from the app-server's environment under Layer 2.
pub const ENV_REMOVED: &[&str] = &[
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "TEMP",
    "TMP",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_connect_to_the_measured_hosts_is_allowed() {
        let ok = |h: &str| allowed_target(h.as_bytes());
        assert_eq!(
            ok("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n").unwrap(),
            "chatgpt.com:443"
        );
        assert!(ok("CONNECT AUTH.openai.com:443 HTTP/1.1\r\n\r\n").is_ok());
        for bad in [
            "CONNECT example.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT chatgpt.com:80 HTTP/1.1\r\n\r\n",
            "CONNECT chatgpt.com.evil.test:443 HTTP/1.1\r\n\r\n",
            "CONNECT chatgpt.com:443@evil.test:443 HTTP/1.1\r\n\r\n",
            "CONNECT chatgpt.com:443 HTTP/1.1 extra\r\n\r\n",
            "GET http://chatgpt.com/ HTTP/1.1\r\n\r\n",
            "CONNECT chatgpt.com:443\r\n\r\n",
            "CONNECT  chatgpt.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n",
        ] {
            assert!(ok(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_profile_denies_by_default_and_names_only_our_folders() {
        let f = Folders {
            program: "/data/agent/bin/0.163.0".into(),
            codex_home: "/data/agent/codex-home".into(),
            sessions: "/data/agent/sessions".into(),
        };
        let p = profile(&f, 50123);
        assert!(p.starts_with("(version 1)\n(deny default)\n"));
        assert!(p.contains(r#"(allow network-outbound (remote ip "localhost:50123"))"#));
        assert_eq!(p.matches("network-outbound").count(), 1);
        assert!(p.contains(r#"(local ip "localhost:1455")"#));
        // Writes: Codex's folder and the work folders, never the home folder or the program.
        let writes = p
            .split("(allow file-write*")
            .nth(1)
            .unwrap()
            .split(")\n(")
            .next()
            .unwrap();
        assert!(
            writes.contains("/data/agent/codex-home") && writes.contains("/data/agent/sessions")
        );
        assert!(!writes.contains("/data/agent/bin"));
        assert!(p.contains(r#"(deny file-write* (literal "/data/agent/codex-home/config.toml")"#));
        for planted in [
            ".env\")",
            "hooks.json\")",
            "(subpath \"/data/agent/codex-home/hooks\")",
        ] {
            assert!(p.contains(planted), "{planted}");
        }
        assert!(!p.contains("(allow default)"));
        assert!(!p.contains("Users"));
        // System services: a fixed list, and none that starts or talks to another program.
        assert!(p.contains(
            r#"(allow mach-lookup (global-name "com.apple.system.notification_center" "#
        ));
        assert_eq!(p.matches("mach-lookup").count(), 1);
        for open in [
            "launchservices",
            "lsd",
            "appleevents",
            "pasteboard",
            "coreservicesd",
            "tccd",
        ] {
            assert!(!p.to_lowercase().contains(open), "{open}");
        }
    }

    #[test]
    fn paths_are_quoted_for_the_profile_language() {
        assert_eq!(quoted(Path::new(r#"/a "b"\c"#)), r#""/a \"b\"\\c""#);
        assert_eq!(
            quoted(Path::new("/Users/x/Library/Application Support/s")),
            "\"/Users/x/Library/Application Support/s\""
        );
    }

    #[test]
    fn the_app_server_gets_our_proxy_and_a_private_temporary_folder() {
        let env = env_overrides(Path::new("/data/agent/codex-home"), 4242);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("HTTPS_PROXY"), Some("http://127.0.0.1:4242"));
        assert_eq!(get("http_proxy"), Some("http://127.0.0.1:4242"));
        assert_eq!(get("TMPDIR"), Some("/data/agent/codex-home/tmp/"));
        assert_eq!(get("GIT_CONFIG_GLOBAL"), Some("/dev/null"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_owner_check_finds_our_own_socket_and_not_another_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let server_port = listener.local_addr().unwrap().port();
        let client = TcpStream::connect(("127.0.0.1", server_port))
            .await
            .unwrap();
        let (_accepted, _) = listener.accept().await.unwrap();
        let client_port = client.local_addr().unwrap().port();
        let me = std::process::id();
        assert!(pid_owns_connection(me, client_port, server_port));
        assert!(!pid_owns_connection(
            me,
            client_port.wrapping_add(1),
            server_port
        ));
        assert!(!pid_owns_connection(
            me,
            client_port,
            server_port.wrapping_add(1)
        ));
        // The launchd process does not hold it (and we may not even look).
        assert!(!pid_owns_connection(1, client_port, server_port));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_proxy_serves_its_process_and_refuses_another() {
        use std::sync::atomic::AtomicBool;
        // An owner check that says yes or no on demand, to drive the proxy without a child.
        static SAY: AtomicBool = AtomicBool::new(false);
        fn check(_: u32, _: u16, _: u16) -> bool {
            SAY.load(Ordering::SeqCst)
        }
        let proxy = Proxy::start(check).await.unwrap();
        proxy.set_app_pid(std::process::id());

        let ask = |head: &'static str| async move {
            let mut s = TcpStream::connect(("127.0.0.1", proxy_port()))
                .await
                .unwrap();
            s.write_all(head.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            let _ = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut out)).await;
            String::from_utf8_lossy(&out).into_owned()
        };
        static PORT: AtomicU32 = AtomicU32::new(0);
        PORT.store(proxy.port() as u32, Ordering::SeqCst);
        fn proxy_port() -> u16 {
            PORT.load(Ordering::SeqCst) as u16
        }

        // Not the app-server: the connection is closed without an answer.
        SAY.store(false, Ordering::SeqCst);
        assert_eq!(ask("CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n").await, "");
        // The app-server, but a host that is not allowed.
        SAY.store(true, Ordering::SeqCst);
        assert!(ask("CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            .await
            .starts_with("HTTP/1.1 403"));
        assert!(ask("GET http://example.com/ HTTP/1.1\r\n\r\n")
            .await
            .starts_with("HTTP/1.1 403"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_profile_compiles_and_confines_a_command() {
        let base = std::env::temp_dir().join(format!("sanctum-outer-{}", uuid::Uuid::new_v4()));
        let (home, sessions) = (base.join("home"), base.join("sessions"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let base = base.canonicalize().unwrap();
        let f = Folders {
            program: "/usr/bin".into(),
            codex_home: base.join("home"),
            sessions: base.join("sessions"),
        };
        let p = profile(&f, 1);
        let run = |script: &str| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &p, "/bin/sh", "-c", script])
                .env_clear()
                .output()
                .unwrap()
        };
        let inside = f.sessions.join("a.txt");
        assert!(run(&format!("echo hi > '{}'", inside.display()))
            .status
            .success());
        assert!(
            run(&format!(
                "echo hi > '{}'",
                base.join("outside.txt").display()
            ))
            .status
            .code()
                != Some(0)
        );
        assert!(!base.join("outside.txt").exists());
        let config = f.codex_home.join("config.toml");
        assert!(!run(&format!("echo x > '{}'", config.display()))
            .status
            .success());
        assert!(!config.exists());
        let secret = std::env::var("HOME")
            .map(|h| format!("{h}/.zshrc"))
            .unwrap_or_default();
        if Path::new(&secret).is_file() {
            assert!(!run(&format!("cat '{secret}'")).status.success());
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}

/// Live check against a real Codex, run by hand:
/// `SANCTUM_TEST_CODEX=/path/to/codex cargo test --lib live_layer_2 -- --ignored --nocapture`.
/// Uses a fresh `CODEX_HOME`, so no account is involved.
#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;
    use crate::agent::process::{AgentProcess, Outer};
    use serde_json::{json, Value};

    /// Reads the account under the profile with a copy of a real sign-in, the way Settings does.
    /// `SANCTUM_TEST_AUTH=<CODEX_HOME>/auth.json SANCTUM_TEST_CODEX=… cargo test --lib
    /// live_account -- --ignored --nocapture`. The copy is deleted afterwards.
    #[tokio::test]
    #[ignore]
    async fn live_account() {
        let codex = PathBuf::from(std::env::var("SANCTUM_TEST_CODEX").expect("SANCTUM_TEST_CODEX"));
        let auth = PathBuf::from(std::env::var("SANCTUM_TEST_AUTH").expect("SANCTUM_TEST_AUTH"));
        let base = std::env::temp_dir().join(format!("sanctum-live-{}", uuid::Uuid::new_v4()));
        let (home, sessions) = (base.join("home"), base.join("sessions"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::copy(&auth, home.join("auth.json")).unwrap();
        let folders = Folders {
            program: codex.parent().unwrap().canonicalize().unwrap(),
            codex_home: home.canonicalize().unwrap(),
            sessions: sessions.canonicalize().unwrap(),
        };
        let proxy = Proxy::start(pid_owns_connection).await.unwrap();
        let p = AgentProcess::start_in(
            &codex,
            &home,
            "0.0.0-live",
            Some(Outer {
                proxy: &proxy,
                folders: &folders,
            }),
        )
        .await
        .expect("start under the profile");
        let r = p
            .rpc
            .request(
                "account/read",
                json!({"refreshToken": false}),
                Duration::from_secs(30),
            )
            .await;
        p.shutdown().await;
        let _ = std::fs::remove_dir_all(&base);
        let r = r.expect("account/read");
        println!("account/read: {}", r["account"]["type"]);
        assert!(r["account"].is_object(), "{r}");
    }

    #[tokio::test]
    #[ignore]
    async fn live_layer_2() {
        let codex = PathBuf::from(std::env::var("SANCTUM_TEST_CODEX").expect("SANCTUM_TEST_CODEX"));
        let base = std::env::temp_dir().join(format!("sanctum-live-{}", uuid::Uuid::new_v4()));
        let (home, sessions) = (base.join("home"), base.join("sessions"));
        let work = sessions.join("s1");
        std::fs::create_dir_all(work.join(".tmp")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let folders = Folders {
            program: codex.parent().unwrap().canonicalize().unwrap(),
            codex_home: home.canonicalize().unwrap(),
            sessions: sessions.canonicalize().unwrap(),
        };
        let work = work.canonicalize().unwrap();
        let proxy = Proxy::start(pid_owns_connection).await.unwrap();
        let p = AgentProcess::start_in(
            &codex,
            &home,
            "0.0.0-live",
            Some(Outer {
                proxy: &proxy,
                folders: &folders,
            }),
        )
        .await
        .expect("start under the profile");

        let home_dir = std::env::var("HOME").unwrap();
        let run = |cmd: Vec<String>| {
            let work = work.clone();
            let rpc = &p.rpc;
            async move {
                let r: Value = rpc
                    .request(
                        "command/exec",
                        json!({"command": cmd, "cwd": work, "timeoutMs": 10000,
                               "env": {"TMPDIR": work.join(".tmp")},
                               "sandboxPolicy": crate::agent::chat::sandbox_policy(&work, true)}),
                        Duration::from_secs(20),
                    )
                    .await
                    .expect("command/exec");
                let out = format!(
                    "{}{}",
                    r["stdout"].as_str().unwrap_or(""),
                    r["stderr"].as_str().unwrap_or("")
                );
                (r["exitCode"].as_i64().unwrap_or(-1), out)
            }
        };
        let sh = |s: &str| vec!["sh".to_string(), "-c".to_string(), s.to_string()];

        let (code, out) = run(sh("echo hi > in.txt && cat in.txt")).await;
        println!("write work: {code} {out}");
        assert_eq!((code, out.trim()), (0, "hi"));
        let (code, out) = run(sh("cat > h.txt <<X\nhello\nX\ncat h.txt")).await;
        println!("heredoc: {code} {out}");
        assert_eq!(code, 0);
        let (code, out) = run(sh(&format!("echo x > {home_dir}/sanctum-live.txt"))).await;
        println!("write home: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(&format!("head -c 10 {home_dir}/.zshrc"))).await;
        println!("read zshrc: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(&format!("ls {home_dir}/.ssh"))).await;
        println!("read ssh: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(&format!(
            "echo x >> '{}'",
            folders.codex_home.join("config.toml").display()
        )))
        .await;
        println!("write config.toml: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(&format!(
            "cd '{}' && {{ echo X=1 > .env || echo refused; }} && {{ echo '{{}}' > hooks.json || echo refused; }} && {{ mkdir -p hooks || echo refused; }}",
            folders.codex_home.display()
        )))
        .await;
        println!("plant .env and hooks: {code} {out}");
        assert_eq!(out.matches("refused").count(), 3, "{out}");
        let (code, out) = run(sh("echo proxy=${HTTPS_PROXY:-none}")).await;
        println!("env: {code} {out}");
        let port = proxy.port();
        let (code, out) = run(sh(&format!(
            "curl -sS -m 5 -o /dev/null -w '%{{http_code}}' -x http://127.0.0.1:{port} https://chatgpt.com"
        )))
        .await;
        println!("command through proxy: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(
            "curl -sS -m 5 --noproxy '*' -o /dev/null https://chatgpt.com",
        ))
        .await;
        println!("command direct: {code} {out}");
        assert_ne!(code, 0);
        // Starting a program outside the sandbox: through Launch Services (`open`) or by sending
        // Apple events (`osascript`). Either would undo every rule above.
        let (code, out) = run(sh("open -g -a TextEdit")).await;
        println!("open: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh("open -g https://example.com")).await;
        println!("open url: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(
            "osascript -e 'tell application \"Finder\" to get name of startup disk'",
        ))
        .await;
        println!("osascript: {code} {out}");
        assert_ne!(code, 0);
        let (code, out) = run(sh(
            "security dump-keychain 2>&1 | head -c 300; echo; security find-generic-password -s 'Safari Forms AutoFill' -w 2>&1 | head -c 200",
        ))
        .await;
        println!("keychain: {code} {out}");
        assert!(!out.contains("keychain: \"/Users"), "{out}");
        assert!(!out.contains("class:"), "{out}");
        // A hard link is a second name for the same file, in a folder the profile opens. Reading
        // a private file through one would undo the read rules.
        std::fs::write(format!("{home_dir}/.sanctum-link-probe"), b"secret-probe").unwrap();
        let (code, out) = run(sh(&format!(
            "ln {home_dir}/.sanctum-link-probe probe; cat probe; ln {home_dir}/.zshrc z; head -c 5 z"
        )))
        .await;
        let _ = std::fs::remove_file(format!("{home_dir}/.sanctum-link-probe"));
        println!("hard link: {code} {out}");
        assert!(!out.contains("secret-probe"), "{out}");
        let (code, out) = run(sh("pbpaste | head -c 20")).await;
        println!("pbpaste: {code} {out:?}");
        assert!(out.trim().is_empty() || code != 0);
        let (code, out) = run(vec!["python3".into(), "-c".into(), "print(6*7)".into()]).await;
        println!("python3: {code} {out}");
        assert_eq!(code, 0);
        let (code, out) = run(sh("git --version && node -e 'console.log(6*7)' 2>&1; true")).await;
        println!("git, node: {code} {out}");
        p.shutdown().await;
        assert!(!Path::new(&format!("{home_dir}/sanctum-live.txt")).exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
