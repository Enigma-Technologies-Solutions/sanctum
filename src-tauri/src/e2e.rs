// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Remote control for the end-to-end suite in `e2e/`. **Development builds only**: in a release
//! build every function here is a no-op that reports "off", and the socket code is not compiled.
//!
//! When a development build starts with `SANCTUM_E2E_SOCKET=<path>`, it listens on that Unix
//! socket for one JSON request per line and answers one JSON line each:
//!
//! - `{"id":1,"op":"eval","window":"main","js":"return document.title"}` runs `js` as the body
//!   of an async function in that window and answers `{"id":1,"ok":<value>}` or
//!   `{"id":1,"error":"..."}`. The value goes back through Sanctum's own event system, so it
//!   works only in Sanctum's windows (main, create), never in tool or preview windows, which have
//!   no IPC.
//! - `{"id":2,"op":"windows"}` answers the labels of the open windows.
//! - `{"id":3,"op":"browser"}` answers the addresses Sanctum would have opened in the browser.
//!   While the socket is on, sign-in records the address instead of opening it.
//!
//! The socket file is created with the user's default permissions in a folder the test chooses.

#[cfg(debug_assertions)]
use std::sync::Mutex;

/// The event the page emits with an answer.
#[cfg(debug_assertions)]
const REPLY_EVENT: &str = "e2e-reply";

#[cfg(debug_assertions)]
static BROWSER: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// True when this is a development build started by the end-to-end suite.
pub fn enabled() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("SANCTUM_E2E_SOCKET").is_some()
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// Opens `url` in the browser, or under the suite only records it.
pub fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if enabled() {
        BROWSER.lock().unwrap().push(url.to_owned());
        return Ok(());
    }
    webbrowser::open(url).map_err(|e| e.to_string())
}

/// Starts the socket if the suite asked for it.
pub fn start(_app: &tauri::AppHandle) {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("SANCTUM_E2E_SOCKET") {
        imp::start(_app.clone(), std::path::PathBuf::from(path));
    }
}

#[cfg(debug_assertions)]
mod imp {
    use super::{BROWSER, REPLY_EVENT};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Listener, Manager};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::sync::oneshot;

    type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

    const EVAL_TIMEOUT: Duration = Duration::from_secs(60);

    pub fn start(app: AppHandle, path: PathBuf) {
        let pending: Pending = Arc::default();
        let p = pending.clone();
        app.listen_any(REPLY_EVENT, move |ev| {
            let Ok(v) = serde_json::from_str::<Value>(ev.payload()) else {
                return;
            };
            let Some(id) = v.get("id").and_then(Value::as_u64) else {
                return;
            };
            if let Some(tx) = p.lock().unwrap().remove(&id) {
                let _ = tx.send(v);
            }
        });
        tauri::async_runtime::spawn(async move {
            let _ = std::fs::remove_file(&path);
            let listener = match UnixListener::bind(&path) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[e2e] cannot listen on {}: {e}", path.display());
                    return;
                }
            };
            eprintln!("[e2e] listening on {}", path.display());
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let app = app.clone();
                let pending = pending.clone();
                tauri::async_runtime::spawn(async move {
                    let (r, mut w) = stream.into_split();
                    let mut lines = BufReader::new(r).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let answer = match serde_json::from_str::<Value>(&line) {
                            Ok(req) => handle(&app, &pending, req).await,
                            Err(e) => json!({"error": format!("bad request: {e}")}),
                        };
                        let mut out = answer.to_string();
                        out.push('\n');
                        if w.write_all(out.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
    }

    static NEXT: AtomicU64 = AtomicU64::new(1);

    async fn handle(app: &AppHandle, pending: &Pending, req: Value) -> Value {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let str_of = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        match str_of("op").as_str() {
            "windows" => {
                let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
                labels.sort();
                json!({"id": id, "ok": labels})
            }
            "browser" => json!({"id": id, "ok": *BROWSER.lock().unwrap()}),
            "eval" => {
                let label = str_of("window");
                let Some(win) = app.get_webview_window(&label) else {
                    return json!({"id": id, "error": format!("no window {label}")});
                };
                let n = NEXT.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = oneshot::channel();
                pending.lock().unwrap().insert(n, tx);
                let script = wrap(n, &str_of("js"));
                if let Err(e) = win.eval(&script) {
                    pending.lock().unwrap().remove(&n);
                    return json!({"id": id, "error": e.to_string()});
                }
                match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
                    Ok(Ok(v)) => {
                        let mut out = json!({"id": id});
                        match v.get("error") {
                            Some(Value::String(e)) => out["error"] = json!(e),
                            _ => out["ok"] = v.get("ok").cloned().unwrap_or(Value::Null),
                        }
                        out
                    }
                    _ => {
                        pending.lock().unwrap().remove(&n);
                        json!({"id": id, "error": "no answer from the page"})
                    }
                }
            }
            other => json!({"id": id, "error": format!("unknown op {other:?}")}),
        }
    }

    /// The page runs `body` as an async function and sends back what it returns, or the error.
    fn wrap(n: u64, body: &str) -> String {
        format!(
            r#"(async () => {{
  let ok = null, error = null;
  try {{ ok = await (async () => {{ {body}
  }})(); }} catch (e) {{ error = String((e && e.stack) || e); }}
  try {{ ok = JSON.parse(JSON.stringify(ok === undefined ? null : ok)); }} catch (e) {{ ok = String(ok); }}
  window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {{ event: "{REPLY_EVENT}", payload: {{ id: {n}, ok, error }} }});
}})();"#
        )
    }
}
