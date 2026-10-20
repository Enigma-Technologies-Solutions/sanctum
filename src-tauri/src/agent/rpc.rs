// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Newline-delimited JSON-RPC over any pair of async streams.
//!
//! Generic over the streams so every rule here is tested with in-memory pipes, no process and
//! no network. The rules:
//!
//! - A line longer than [`MAX_LINE_BYTES`] ends the connection. Nothing is parsed from it.
//! - A line that is not JSON is ignored.
//! - **A request from the server is always refused** (`-32601`). Sanctum answers no server
//!   request: approvals, token refreshes and tool calls all have no handler by design.
//! - When the stream ends, every waiting request fails with [`RpcError::Closed`].

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

/// Longest accepted line. Generous for a model reply, small enough that a runaway process
/// cannot make Sanctum buffer without limit.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Delivered to subscribers, once, when the stream ends. Not a real protocol method.
pub const CLOSED_EVENT: &str = "rpc/closed";

/// Longest server error message kept.
const MAX_ERROR_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    /// The stream ended or could not be written.
    Closed,
    /// A line exceeded [`MAX_LINE_BYTES`].
    TooLarge,
    /// No answer within the allowed time.
    Timeout,
    /// The server answered with an error.
    Remote { code: i64, message: String },
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Closed => write!(f, "the agent process stopped"),
            RpcError::TooLarge => write!(f, "the agent sent a message that was too large"),
            RpcError::Timeout => write!(f, "the agent did not answer in time"),
            RpcError::Remote { message, .. } => write!(f, "{message}"),
        }
    }
}

/// A message from the server that is not an answer to a request.
#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct Rpc {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    events: broadcast::Sender<Notification>,
    closed: watch::Receiver<bool>,
    denied: Arc<AtomicU64>,
}

enum Line {
    Text(String),
    Eof,
    TooLarge,
}

/// Reads one line without ever holding more than `cap` bytes of it.
async fn read_capped<R: AsyncBufRead + Unpin>(r: &mut R, cap: usize) -> io::Result<Line> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = r.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(if buf.is_empty() {
                Line::Eof
            } else {
                Line::Text(String::from_utf8_lossy(&buf).into_owned())
            });
        }
        match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => {
                if buf.len() + i > cap {
                    return Ok(Line::TooLarge);
                }
                buf.extend_from_slice(&chunk[..i]);
                r.consume(i + 1);
                return Ok(Line::Text(String::from_utf8_lossy(&buf).into_owned()));
            }
            None => {
                let n = chunk.len();
                if buf.len() + n > cap {
                    return Ok(Line::TooLarge);
                }
                buf.extend_from_slice(chunk);
                r.consume(n);
            }
        }
    }
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_ERROR_CHARS).collect()
}

impl Rpc {
    /// Starts the reader and writer tasks. Must be called inside a Tokio runtime.
    pub fn start<R, W>(reader: R, writer: W) -> Rpc
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(256);
        let (closed_tx, closed) = watch::channel(false);
        let denied = Arc::new(AtomicU64::new(0));

        // Writer. Ends when every sender is dropped or the stream fails.
        let closed_w = closed_tx.clone();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(line) = out_rx.recv().await {
                let ok = writer.write_all(line.as_bytes()).await.is_ok()
                    && writer.write_all(b"\n").await.is_ok()
                    && writer.flush().await.is_ok();
                if !ok {
                    let _ = closed_w.send(true);
                    break;
                }
            }
        });

        // Reader.
        let pending_r = pending.clone();
        let events_r = events.clone();
        let out_r = out.clone();
        let denied_r = denied.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let reason = loop {
                let line = match read_capped(&mut reader, MAX_LINE_BYTES).await {
                    Ok(Line::Text(t)) => t,
                    Ok(Line::Eof) | Err(_) => break RpcError::Closed,
                    Ok(Line::TooLarge) => break RpcError::TooLarge,
                };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let id = msg.get("id").cloned();
                let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
                match (id, method) {
                    // The server asks something of us: refuse, always.
                    (Some(id), Some(_)) => {
                        denied_r.fetch_add(1, Ordering::SeqCst);
                        let _ = out_r.send(
                            json!({"id": id, "error": {"code": -32601, "message": "Sanctum does not handle requests from the agent"}})
                                .to_string(),
                        );
                    }
                    // An answer to one of ours.
                    (Some(id), None) => {
                        let Some(id) = id.as_u64() else { continue };
                        let Some(tx) = pending_r.lock().unwrap().remove(&id) else {
                            continue;
                        };
                        let result = if let Some(err) = msg.get("error") {
                            Err(RpcError::Remote {
                                code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                                message: clip(
                                    err.get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("the agent reported an error"),
                                ),
                            })
                        } else {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(result);
                    }
                    (None, Some(method)) => {
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        let _ = events_r.send(Notification { method, params });
                    }
                    (None, None) => {}
                }
            };
            // Order matters: mark closed first, then drain, so a request that is inserted
            // after the drain still sees `closed` and gives up (see `request`).
            let _ = closed_tx.send(true);
            let drained: Vec<_> = pending_r.lock().unwrap().drain().collect();
            for (_, tx) in drained {
                let _ = tx.send(Err(reason.clone()));
            }
            let _ = events_r.send(Notification {
                method: CLOSED_EVENT.into(),
                params: Value::Null,
            });
        });

        Rpc {
            out,
            pending,
            next_id: AtomicU64::new(1),
            events,
            closed,
            denied,
        }
    }

    /// Sends a request and waits for its answer.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        if *self.closed.borrow() {
            return Err(RpcError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if *self.closed.borrow() {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcError::Closed);
        }
        let msg = json!({"method": method, "id": id, "params": params}).to_string();
        if self.out.send(msg).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcError::Closed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::Closed),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcError::Timeout)
            }
        }
    }

    /// Sends a message that expects no answer.
    pub fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.out
            .send(json!({"method": method, "params": params}).to_string())
            .map_err(|_| RpcError::Closed)
    }

    /// Notifications from the server. Subscribe before sending the request whose
    /// notification you wait for.
    pub fn subscribe(&self) -> broadcast::Receiver<Notification> {
        self.events.subscribe()
    }

    /// True once the stream has ended.
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// How many requests from the server were refused.
    pub fn denied_requests(&self) -> u64 {
        self.denied.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use tokio::io::{duplex, DuplexStream, ReadHalf, WriteHalf};

    /// The other end of an [`Rpc`], driven by a test.
    pub struct Fake {
        reader: BufReader<ReadHalf<DuplexStream>>,
        writer: WriteHalf<DuplexStream>,
    }

    impl Fake {
        pub async fn recv(&mut self) -> Value {
            let mut line = String::new();
            self.reader.read_line(&mut line).await.unwrap();
            serde_json::from_str(&line).expect("client sent invalid JSON")
        }
        pub async fn send(&mut self, v: Value) {
            self.send_raw(&v.to_string()).await;
        }
        pub async fn send_raw(&mut self, s: &str) {
            self.writer.write_all(s.as_bytes()).await.unwrap();
            self.writer.write_all(b"\n").await.unwrap();
            self.writer.flush().await.unwrap();
        }
        /// Answers the next request with `result`.
        pub async fn answer(&mut self, result: Value) -> Value {
            let req = self.recv().await;
            self.send(json!({"id": req["id"], "result": result})).await;
            req
        }
        /// Writes bytes with no newline added.
        pub async fn write_bytes(&mut self, b: &[u8]) {
            let _ = self.writer.write_all(b).await;
        }
        pub fn close(self) {}
    }

    pub fn pair() -> (Rpc, Fake) {
        let (client_end, server_end) = duplex(1 << 20);
        let (cr, cw) = tokio::io::split(client_end);
        let (sr, sw) = tokio::io::split(server_end);
        (
            Rpc::start(cr, cw),
            Fake {
                reader: BufReader::new(sr),
                writer: sw,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::testing::pair;
    use super::*;

    const T: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn answers_are_matched_by_id_even_out_of_order() {
        let (rpc, mut fake) = pair();
        let rpc = Arc::new(rpc);
        let (a, b) = (rpc.clone(), rpc.clone());
        let ta = tokio::spawn(async move { a.request("first", json!({}), T).await });
        let tb = tokio::spawn(async move { b.request("second", json!({}), T).await });
        let r1 = fake.recv().await;
        let r2 = fake.recv().await;
        // Answer in reverse order.
        fake.send(
            json!({"id": r2["id"], "result": format!("for {}", r2["method"].as_str().unwrap())}),
        )
        .await;
        fake.send(
            json!({"id": r1["id"], "result": format!("for {}", r1["method"].as_str().unwrap())}),
        )
        .await;
        let (ra, rb) = (ta.await.unwrap().unwrap(), tb.await.unwrap().unwrap());
        assert_eq!(ra, json!("for first"));
        assert_eq!(rb, json!("for second"));
    }

    #[tokio::test]
    async fn remote_errors_are_returned_and_clipped() {
        let (rpc, mut fake) = pair();
        let task = tokio::spawn(async move { rpc.request("x", json!({}), T).await });
        let req = fake.recv().await;
        let long = "e".repeat(5000);
        fake.send(json!({"id": req["id"], "error": {"code": -32000, "message": long}}))
            .await;
        match task.await.unwrap() {
            Err(RpcError::Remote { code, message }) => {
                assert_eq!(code, -32000);
                assert_eq!(message.chars().count(), MAX_ERROR_CHARS);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn notifications_reach_subscribers() {
        let (rpc, mut fake) = pair();
        let mut rx = rpc.subscribe();
        fake.send(json!({"method": "account/updated", "params": {"authMode": "chatgpt"}}))
            .await;
        let n = rx.recv().await.unwrap();
        assert_eq!(n.method, "account/updated");
        assert_eq!(n.params["authMode"], "chatgpt");
    }

    #[tokio::test]
    async fn requests_from_the_server_are_refused_and_the_connection_survives() {
        let (rpc, mut fake) = pair();
        fake.send(json!({"id": 77, "method": "item/permissions/requestApproval", "params": {}}))
            .await;
        let reply = fake.recv().await;
        assert_eq!(reply["id"], 77);
        assert_eq!(reply["error"]["code"], -32601);
        assert!(reply.get("result").is_none());
        assert_eq!(rpc.denied_requests(), 1);
        // Still usable afterwards.
        let rpc = Arc::new(rpc);
        let r = rpc.clone();
        let t = tokio::spawn(async move { r.request("ping", json!({}), T).await });
        fake.answer(json!("pong")).await;
        assert_eq!(t.await.unwrap().unwrap(), json!("pong"));
    }

    #[tokio::test]
    async fn string_ids_in_server_requests_are_refused_with_the_same_id() {
        let (_rpc, mut fake) = pair();
        fake.send(
            json!({"id": "abc", "method": "account/chatgptAuthTokens/refresh", "params": {}}),
        )
        .await;
        let reply = fake.recv().await;
        assert_eq!(reply["id"], "abc");
        assert_eq!(reply["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn junk_lines_and_unknown_ids_are_ignored() {
        let (rpc, mut fake) = pair();
        let rpc = Arc::new(rpc);
        let r = rpc.clone();
        let t = tokio::spawn(async move { r.request("ping", json!({}), T).await });
        let req = fake.recv().await;
        fake.send_raw("this is not json").await;
        fake.send_raw("").await;
        fake.send(json!({"id": 9999, "result": "stray"})).await;
        fake.send(json!({"id": req["id"], "result": "ok"})).await;
        assert_eq!(t.await.unwrap().unwrap(), json!("ok"));
    }

    #[tokio::test]
    async fn an_oversized_line_closes_the_connection_and_fails_waiters() {
        let (rpc, mut fake) = pair();
        let rpc = Arc::new(rpc);
        let r = rpc.clone();
        let t = tokio::spawn(async move { r.request("ping", json!({}), T).await });
        fake.recv().await;
        // One byte over the limit, no newline needed before the cap is hit.
        let big = "x".repeat(MAX_LINE_BYTES + 1);
        let sender = tokio::spawn(async move {
            fake.write_bytes(big.as_bytes()).await;
            fake
        });
        assert_eq!(t.await.unwrap(), Err(RpcError::TooLarge));
        assert!(rpc.is_closed());
        assert_eq!(
            rpc.request("again", json!({}), T).await,
            Err(RpcError::Closed)
        );
        drop(sender);
    }

    #[tokio::test]
    async fn a_complete_line_one_byte_over_the_limit_is_refused() {
        let (rpc, mut fake) = pair();
        let rpc = Arc::new(rpc);
        let r = rpc.clone();
        let t = tokio::spawn(async move { r.request("ping", json!({}), T).await });
        fake.recv().await;
        let head = r#"{"method":"m","params":""#;
        let tail = r#""}"#;
        let pad = "y".repeat(MAX_LINE_BYTES + 1 - head.len() - tail.len());
        let line = format!("{head}{pad}{tail}");
        assert_eq!(line.len(), MAX_LINE_BYTES + 1);
        let w = tokio::spawn(async move {
            fake.send_raw(&line).await;
            fake
        });
        assert_eq!(t.await.unwrap(), Err(RpcError::TooLarge));
        drop(w);
    }

    #[tokio::test]
    async fn a_line_exactly_at_the_limit_is_accepted() {
        let (rpc, mut fake) = pair();
        let mut rx = rpc.subscribe();
        // {"method":"m","params":"<pad>"} padded so the whole line is exactly the cap.
        let head = r#"{"method":"m","params":""#;
        let tail = r#""}"#;
        let pad = "y".repeat(MAX_LINE_BYTES - head.len() - tail.len());
        let line = format!("{head}{pad}{tail}");
        assert_eq!(line.len(), MAX_LINE_BYTES);
        fake.send_raw(&line).await;
        let n = rx.recv().await.unwrap();
        assert_eq!(n.method, "m");
    }

    #[tokio::test]
    async fn end_of_stream_fails_waiters_with_closed() {
        let (rpc, mut fake) = pair();
        let rpc = Arc::new(rpc);
        let r = rpc.clone();
        let t = tokio::spawn(async move { r.request("ping", json!({}), T).await });
        fake.recv().await;
        fake.close();
        assert_eq!(t.await.unwrap(), Err(RpcError::Closed));
        assert!(rpc.is_closed());
    }

    #[tokio::test]
    async fn subscribers_are_told_when_the_stream_ends() {
        let (rpc, fake) = pair();
        let mut rx = rpc.subscribe();
        fake.close();
        let n = rx.recv().await.unwrap();
        assert_eq!(n.method, CLOSED_EVENT);
    }

    #[tokio::test]
    async fn an_unanswered_request_times_out_and_leaves_nothing_pending() {
        let (rpc, mut fake) = pair();
        let r = rpc
            .request("ping", json!({}), Duration::from_millis(50))
            .await;
        assert_eq!(r, Err(RpcError::Timeout));
        assert!(rpc.pending.lock().unwrap().is_empty());
        fake.recv().await;
    }

    #[tokio::test]
    async fn notify_sends_no_id() {
        let (rpc, mut fake) = pair();
        rpc.notify("initialized", json!({})).unwrap();
        let m = fake.recv().await;
        assert_eq!(m["method"], "initialized");
        assert!(m.get("id").is_none());
    }
}
