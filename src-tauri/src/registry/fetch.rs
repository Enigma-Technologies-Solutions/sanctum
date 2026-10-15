// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Downloads with limits. Everything here is policy; the bytes are verified elsewhere.
//!
//! - HTTPS only. A plain `http://` URL is refused before any connection is made.
//! - At most [`Limits::max_redirects`] redirects, and each must stay on the same origin
//!   (scheme, host and port) as the request it came from. A registry cannot send the client
//!   to another host.
//! - A hard cap on body size, checked against `Content-Length` first and then while reading,
//!   so a server that lies or streams forever cannot fill memory.
//! - A stall timeout between chunks and a total timeout for the whole download.
//! - No credentials in URLs, no cookies, no decompression (so no decompression bombs).
//!
//! The network is behind [`Transport`] so the tests can script servers that misbehave.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use url::Url;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// Not a usable URL (no host, credentials, fragment, and so on).
    InvalidUrl(String),
    /// Not `https`.
    Insecure,
    TooLarge {
        limit: usize,
    },
    Timeout,
    Status(u16),
    TooManyRedirects,
    RedirectRefused(String),
    Transport(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::InvalidUrl(m) => write!(f, "not a usable address: {m}"),
            FetchError::Insecure => write!(f, "registries must be reached over https"),
            FetchError::TooLarge { limit } => write!(f, "the file is larger than {limit} bytes"),
            FetchError::Timeout => write!(f, "the server took too long to answer"),
            FetchError::Status(404) => write!(f, "not found (404)"),
            FetchError::Status(s) => write!(f, "the server answered {s}"),
            FetchError::TooManyRedirects => write!(f, "too many redirects"),
            FetchError::RedirectRefused(why) => write!(f, "refused a redirect: {why}"),
            FetchError::Transport(m) => write!(f, "could not connect: {m}"),
        }
    }
}

impl std::error::Error for FetchError {}

// ── Transport ─────────────────────────────────────────────────────────────────

/// The body of a response, read in chunks.
pub trait Body: Send {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>>;
}

pub struct Response {
    pub status: u16,
    /// The `Location` header, for redirects.
    pub location: Option<String>,
    pub content_length: Option<u64>,
    pub body: Box<dyn Body>,
}

/// One HTTP GET, with no redirect handling, no retries and no decompression.
pub trait Transport: Send + Sync {
    fn get<'a>(&'a self, url: &'a Url) -> BoxFuture<'a, Result<Response, String>>;
}

// ── Limits ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_bytes: usize,
    /// Longest the whole download (including redirects) may take.
    pub total_timeout: Duration,
    /// Longest the server may go without sending the next chunk.
    pub stall_timeout: Duration,
    pub max_redirects: u8,
}

impl Limits {
    pub fn new(max_bytes: usize) -> Limits {
        Limits {
            max_bytes,
            total_timeout: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(15),
            max_redirects: 3,
        }
    }
}

// ── URL checks ────────────────────────────────────────────────────────────────

/// Parse a URL the user or a registry gave us and refuse anything unsafe to request.
/// `allow_query` is false for registry base URLs and true for redirect targets.
pub fn check_url(raw: &str, allow_query: bool) -> Result<Url, FetchError> {
    let url = Url::parse(raw.trim()).map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
    if url.scheme() != "https" {
        return Err(FetchError::Insecure);
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(FetchError::InvalidUrl("no host".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::InvalidUrl(
            "addresses with a user name or password are not accepted".into(),
        ));
    }
    if url.fragment().is_some() {
        return Err(FetchError::InvalidUrl("remove the # part".into()));
    }
    if !allow_query && url.query().is_some() {
        return Err(FetchError::InvalidUrl("remove the ? part".into()));
    }
    Ok(url)
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/// Download `url` within `limits`. Returns the body of a 200 response.
pub async fn fetch(
    transport: &dyn Transport,
    url: &Url,
    limits: Limits,
) -> Result<Vec<u8>, FetchError> {
    tokio::time::timeout(limits.total_timeout, fetch_inner(transport, url, limits))
        .await
        .map_err(|_| FetchError::Timeout)?
}

async fn fetch_inner(
    transport: &dyn Transport,
    start: &Url,
    limits: Limits,
) -> Result<Vec<u8>, FetchError> {
    // Checked again here so a caller that built a URL by hand cannot skip the policy.
    check_url(start.as_str(), true)?;
    let mut current = start.clone();
    let mut hops: u8 = 0;
    loop {
        let response = transport
            .get(&current)
            .await
            .map_err(FetchError::Transport)?;
        match response.status {
            200 => return read_body(response, limits).await,
            301 | 302 | 303 | 307 | 308 => {
                hops += 1;
                if hops > limits.max_redirects {
                    return Err(FetchError::TooManyRedirects);
                }
                let location = response
                    .location
                    .ok_or_else(|| FetchError::RedirectRefused("no Location header".into()))?;
                let next = current
                    .join(&location)
                    .map_err(|e| FetchError::RedirectRefused(e.to_string()))?;
                if next.scheme() != "https" {
                    return Err(FetchError::RedirectRefused("it leaves https".into()));
                }
                if !same_origin(start, &next) {
                    return Err(FetchError::RedirectRefused(format!(
                        "it leaves {}",
                        start.host_str().unwrap_or("the registry")
                    )));
                }
                if !next.username().is_empty() || next.password().is_some() {
                    return Err(FetchError::RedirectRefused("it carries credentials".into()));
                }
                current = next;
            }
            other => return Err(FetchError::Status(other)),
        }
    }
}

async fn read_body(mut response: Response, limits: Limits) -> Result<Vec<u8>, FetchError> {
    if let Some(len) = response.content_length {
        if len > limits.max_bytes as u64 {
            return Err(FetchError::TooLarge {
                limit: limits.max_bytes,
            });
        }
    }
    let mut out = Vec::new();
    loop {
        let chunk = tokio::time::timeout(limits.stall_timeout, response.body.next_chunk())
            .await
            .map_err(|_| FetchError::Timeout)?
            .map_err(FetchError::Transport)?;
        match chunk {
            None => return Ok(out),
            Some(bytes) => {
                if out.len() + bytes.len() > limits.max_bytes {
                    return Err(FetchError::TooLarge {
                        limit: limits.max_bytes,
                    });
                }
                out.extend_from_slice(&bytes);
            }
        }
    }
}

// ── The real transport ────────────────────────────────────────────────────────

pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<ReqwestTransport, String> {
        // reqwest is built without a crypto provider. Install the same one the updater uses,
        // unless something already has.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            // The library refuses plain http itself, as a second line behind check_url.
            .https_only(true)
            // Redirects are followed by `fetch`, where the same-origin rule is enforced.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            // No cookie store and no content decoding features are compiled in.
            .user_agent("Sanctum")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(ReqwestTransport { client })
    }
}

struct ReqwestBody(reqwest::Response);

impl Body for ReqwestBody {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>> {
        Box::pin(async move {
            self.0
                .chunk()
                .await
                .map(|c| c.map(|b| b.to_vec()))
                .map_err(|e| e.to_string())
        })
    }
}

impl Transport for ReqwestTransport {
    fn get<'a>(&'a self, url: &'a Url) -> BoxFuture<'a, Result<Response, String>> {
        Box::pin(async move {
            let resp = self
                .client
                .get(url.as_str())
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            Ok(Response {
                status: resp.status().as_u16(),
                location,
                content_length: resp.content_length(),
                body: Box::new(ReqwestBody(resp)),
            })
        })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod testing {
    //! A scripted server for tests, shared with the client tests.
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Clone)]
    pub enum Script {
        /// 200 with this body and a matching Content-Length.
        Ok(Vec<u8>),
        /// 200 with these chunks, optionally a (possibly false) Content-Length, and a delay
        /// before each chunk.
        Chunks {
            declared_len: Option<u64>,
            chunks: Vec<Vec<u8>>,
            delay: Duration,
        },
        Redirect(u16, String),
        Status(u16),
        /// The connection itself fails.
        Down(String),
    }

    #[derive(Default)]
    pub struct Mock {
        routes: Mutex<HashMap<String, Script>>,
        pub calls: Mutex<Vec<String>>,
    }

    impl Mock {
        pub fn new() -> Mock {
            Mock::default()
        }
        pub fn route(&self, url: &str, script: Script) {
            self.routes.lock().unwrap().insert(url.to_string(), script);
        }
        pub fn serve(&self, url: &str, body: &[u8]) {
            self.route(url, Script::Ok(body.to_vec()));
        }
        pub fn call_count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    struct ChunkBody {
        chunks: std::vec::IntoIter<Vec<u8>>,
        delay: Duration,
    }

    impl Body for ChunkBody {
        fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>> {
            Box::pin(async move {
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                Ok(self.chunks.next())
            })
        }
    }

    fn empty() -> Box<dyn Body> {
        Box::new(ChunkBody {
            chunks: Vec::new().into_iter(),
            delay: Duration::ZERO,
        })
    }

    impl Transport for Mock {
        fn get<'a>(&'a self, url: &'a Url) -> BoxFuture<'a, Result<Response, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(url.to_string());
                let script = self.routes.lock().unwrap().get(url.as_str()).cloned();
                match script {
                    None => Ok(Response {
                        status: 404,
                        location: None,
                        content_length: None,
                        body: empty(),
                    }),
                    Some(Script::Ok(body)) => Ok(Response {
                        status: 200,
                        location: None,
                        content_length: Some(body.len() as u64),
                        body: Box::new(ChunkBody {
                            chunks: vec![body].into_iter(),
                            delay: Duration::ZERO,
                        }),
                    }),
                    Some(Script::Chunks {
                        declared_len,
                        chunks,
                        delay,
                    }) => Ok(Response {
                        status: 200,
                        location: None,
                        content_length: declared_len,
                        body: Box::new(ChunkBody {
                            chunks: chunks.into_iter(),
                            delay,
                        }),
                    }),
                    Some(Script::Redirect(status, to)) => Ok(Response {
                        status,
                        location: Some(to),
                        content_length: None,
                        body: empty(),
                    }),
                    Some(Script::Status(status)) => Ok(Response {
                        status,
                        location: None,
                        content_length: None,
                        body: empty(),
                    }),
                    Some(Script::Down(why)) => Err(why),
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{Mock, Script};
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    const A: &str = "https://registry.test/v1/index.json";

    #[tokio::test]
    async fn a_plain_download_returns_the_body() {
        let m = Mock::new();
        m.serve(A, b"hello");
        assert_eq!(fetch(&m, &u(A), Limits::new(100)).await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn http_is_refused_before_any_connection() {
        let m = Mock::new();
        m.serve("http://registry.test/v1/index.json", b"x");
        let url = u("http://registry.test/v1/index.json");
        assert_eq!(
            fetch(&m, &url, Limits::new(100)).await.unwrap_err(),
            FetchError::Insecure
        );
        assert_eq!(m.call_count(), 0, "no request may be sent over http");
    }

    #[test]
    fn urls_are_checked() {
        assert!(check_url("https://registry.test/v1/", false).is_ok());
        assert!(check_url("  https://registry.test/v1/  ", false).is_ok());
        for (bad, why) in [
            ("http://registry.test/", "http"),
            ("ftp://registry.test/", "ftp"),
            ("file:///etc/passwd", "file"),
            ("javascript:alert(1)", "javascript"),
            ("https://user:pw@registry.test/", "credentials"),
            ("https://user@registry.test/", "user"),
            ("https://registry.test/#frag", "fragment"),
            ("https://registry.test/?a=1", "query"),
            ("https://", "no host"),
            ("https:", "no host"),
            ("not a url", "garbage"),
            ("", "empty"),
        ] {
            assert!(check_url(bad, false).is_err(), "accepted {why}: {bad}");
        }
        // A redirect target may carry a query.
        assert!(check_url("https://registry.test/x?sig=abc", true).is_ok());
    }

    #[tokio::test]
    async fn a_same_origin_redirect_is_followed() {
        let m = Mock::new();
        m.route(A, Script::Redirect(301, "/v2/index.json".into()));
        m.serve("https://registry.test/v2/index.json", b"moved");
        assert_eq!(fetch(&m, &u(A), Limits::new(100)).await.unwrap(), b"moved");
        // Relative and absolute forms both work.
        let m = Mock::new();
        m.route(
            A,
            Script::Redirect(308, "https://registry.test/v2/index.json".into()),
        );
        m.serve("https://registry.test/v2/index.json", b"moved");
        assert!(fetch(&m, &u(A), Limits::new(100)).await.is_ok());
    }

    #[tokio::test]
    async fn redirects_to_another_host_port_or_scheme_are_refused() {
        for target in [
            "https://evil.test/index.json",
            "https://registry.test:8443/index.json",
            "https://sub.registry.test/index.json",
            "http://registry.test/index.json",
            "https://user:pw@registry.test/index.json",
        ] {
            let m = Mock::new();
            m.route(A, Script::Redirect(302, target.into()));
            m.serve(target, b"should never be fetched");
            let e = fetch(&m, &u(A), Limits::new(100)).await.unwrap_err();
            assert!(
                matches!(e, FetchError::RedirectRefused(_)),
                "{target}: {e:?}"
            );
            assert_eq!(
                m.call_count(),
                1,
                "{target}: the target must not be requested"
            );
        }
    }

    #[tokio::test]
    async fn a_redirect_without_a_location_is_refused() {
        let m = Mock::new();
        m.route(A, Script::Status(302));
        assert!(matches!(
            fetch(&m, &u(A), Limits::new(100)).await.unwrap_err(),
            FetchError::RedirectRefused(_)
        ));
    }

    #[tokio::test]
    async fn redirect_loops_and_long_chains_stop() {
        let m = Mock::new();
        m.route(A, Script::Redirect(302, A.into()));
        assert_eq!(
            fetch(&m, &u(A), Limits::new(100)).await.unwrap_err(),
            FetchError::TooManyRedirects
        );
        assert_eq!(m.call_count(), 4, "first request plus three redirects");

        // Exactly the limit is fine.
        let m = Mock::new();
        m.route(A, Script::Redirect(302, "/1".into()));
        m.route(
            "https://registry.test/1",
            Script::Redirect(302, "/2".into()),
        );
        m.route(
            "https://registry.test/2",
            Script::Redirect(302, "/3".into()),
        );
        m.serve("https://registry.test/3", b"end");
        assert_eq!(fetch(&m, &u(A), Limits::new(100)).await.unwrap(), b"end");
    }

    #[tokio::test]
    async fn an_oversize_declared_length_is_refused_without_reading() {
        let m = Mock::new();
        m.route(
            A,
            Script::Chunks {
                declared_len: Some(1_000_000),
                chunks: vec![vec![0; 10]],
                delay: Duration::ZERO,
            },
        );
        assert_eq!(
            fetch(&m, &u(A), Limits::new(1000)).await.unwrap_err(),
            FetchError::TooLarge { limit: 1000 }
        );
    }

    #[tokio::test]
    async fn a_server_that_lies_about_length_or_streams_forever_is_cut_off() {
        // Declares a small body, sends a big one.
        let m = Mock::new();
        m.route(
            A,
            Script::Chunks {
                declared_len: Some(10),
                chunks: vec![vec![0; 600], vec![0; 600]],
                delay: Duration::ZERO,
            },
        );
        assert_eq!(
            fetch(&m, &u(A), Limits::new(1000)).await.unwrap_err(),
            FetchError::TooLarge { limit: 1000 }
        );
        // No length at all, endless chunks.
        let m = Mock::new();
        m.route(
            A,
            Script::Chunks {
                declared_len: None,
                chunks: (0..10_000).map(|_| vec![0; 100]).collect(),
                delay: Duration::ZERO,
            },
        );
        assert_eq!(
            fetch(&m, &u(A), Limits::new(1000)).await.unwrap_err(),
            FetchError::TooLarge { limit: 1000 }
        );
    }

    #[tokio::test]
    async fn exactly_the_limit_is_accepted() {
        let m = Mock::new();
        m.serve(A, &[7u8; 1000]);
        assert_eq!(
            fetch(&m, &u(A), Limits::new(1000)).await.unwrap().len(),
            1000
        );
        let m = Mock::new();
        m.serve(A, &[7u8; 1001]);
        assert!(fetch(&m, &u(A), Limits::new(1000)).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_body_times_out() {
        let m = Mock::new();
        m.route(
            A,
            Script::Chunks {
                declared_len: None,
                chunks: vec![vec![1; 5]],
                delay: Duration::from_secs(20), // longer than the 15 second stall limit
            },
        );
        let started = tokio::time::Instant::now();
        assert_eq!(
            fetch(&m, &u(A), Limits::new(100)).await.unwrap_err(),
            FetchError::Timeout
        );
        // It was the stall limit (15 s) that fired, not the 30 s total.
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_trickle_hits_the_total_timeout() {
        // Each chunk arrives within the stall limit, but the whole takes too long.
        let m = Mock::new();
        m.route(
            A,
            Script::Chunks {
                declared_len: None,
                chunks: (0..100).map(|_| vec![1; 1]).collect(),
                delay: Duration::from_secs(10),
            },
        );
        let started = tokio::time::Instant::now();
        assert_eq!(
            fetch(&m, &u(A), Limits::new(1000)).await.unwrap_err(),
            FetchError::Timeout
        );
        assert!(
            started.elapsed() >= Duration::from_secs(30),
            "{:?}",
            started.elapsed()
        );
        assert!(
            started.elapsed() < Duration::from_secs(41),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn non_200_statuses_and_connection_failures_are_errors() {
        let m = Mock::new();
        assert_eq!(
            fetch(&m, &u(A), Limits::new(100)).await.unwrap_err(),
            FetchError::Status(404)
        );
        for s in [204u16, 206, 400, 403, 500, 503] {
            let m = Mock::new();
            m.route(A, Script::Status(s));
            assert_eq!(
                fetch(&m, &u(A), Limits::new(100)).await.unwrap_err(),
                FetchError::Status(s)
            );
        }
        let m = Mock::new();
        m.route(A, Script::Down("refused".into()));
        assert!(matches!(
            fetch(&m, &u(A), Limits::new(100)).await.unwrap_err(),
            FetchError::Transport(_)
        ));
    }

    #[tokio::test]
    async fn the_real_transport_never_connects_over_plain_http() {
        // A local listener that would notice any connection attempt.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let transport = ReqwestTransport::new().unwrap();
        let url = u(&format!("http://127.0.0.1:{port}/index.json"));
        // Through fetch, the URL check stops it first.
        assert_eq!(
            fetch(&transport, &url, Limits::new(100)).await.unwrap_err(),
            FetchError::Insecure
        );
        // Straight to the transport, the HTTP library itself refuses.
        assert!(transport.get(&url).await.is_err());
        assert!(
            listener.accept().is_err(),
            "something connected to the plain-http listener"
        );
    }
}
