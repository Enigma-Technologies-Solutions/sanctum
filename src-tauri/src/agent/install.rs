// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Getting Codex onto the computer, so the person needs nothing but Sanctum.
//!
//! Codex is not in the installer (it is about 100 MB, 250 to 340 MB unpacked). The first time
//! someone chooses to sign in, Sanctum downloads the exact release pinned in
//! `codex-pins.json` from OpenAI's GitHub releases and checks it before it can run:
//!
//! - the address must be on github.com, and redirects may only go to github.com or
//!   githubusercontent.com, over https;
//! - the download must be exactly the pinned size and match the pinned SHA-256;
//! - exactly one file is taken out of the archive, chosen by name from the pin (the archive
//!   decides no paths), and it must match its own pinned size and SHA-256;
//! - before every start, the program on disk is hashed again.
//!
//! The pins are made by `scripts/pin-codex.py` and reviewed like code. A new Codex version is a
//! Sanctum release. Nothing is downloaded until the person clicks.

use crate::registry::fetch::{check_url, Transport};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

const PINS_JSON: &str = include_str!("codex-pins.json");

/// Longest the whole download may take.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Longest the server may go without sending data.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: u8 = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub url: String,
    pub archive_sha256: String,
    pub archive_size: u64,
    /// Name of the program inside the archive.
    pub entry: String,
    /// Name it is saved under.
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct PinFile {
    version: String,
    pins: HashMap<String, Pin>,
}

/// One pinned Codex release for one platform.
#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub pin: Pin,
}

fn pin_file() -> &'static PinFile {
    static F: OnceLock<PinFile> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(PINS_JSON).expect("codex-pins.json is valid"))
}

/// The key used in `codex-pins.json`: `os-arch`.
pub fn platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// The release for this computer, or `None` where Sanctum does not support the agent.
pub fn release_here() -> Option<Release> {
    let f = pin_file();
    f.pins.get(&platform_key()).map(|p| Release {
        version: f.version.clone(),
        pin: p.clone(),
    })
}

/// Where the program lives once installed.
pub fn binary_path(bin_dir: &Path, rel: &Release) -> PathBuf {
    bin_dir.join(&rel.version).join(&rel.pin.file)
}

/// Cheap check used by the interface: the file is there and has the right size. The hash is
/// checked by [`verify`] before it is ever run.
pub fn is_present(bin_dir: &Path, rel: &Release) -> bool {
    std::fs::metadata(binary_path(bin_dir, rel))
        .is_ok_and(|m| m.is_file() && m.len() == rel.pin.size)
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(h.finalize()), total))
}

/// Whether the installed program is exactly the pinned one. Reads the whole file.
pub async fn verify(bin_dir: &Path, rel: &Release) -> bool {
    let path = binary_path(bin_dir, rel);
    let want = rel.pin.clone();
    tokio::task::spawn_blocking(move || {
        hash_file(&path).is_ok_and(|(sha, len)| len == want.size && sha == want.sha256)
    })
    .await
    .unwrap_or(false)
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallError {
    Cancelled,
    Network(String),
    Timeout,
    /// The download is not what was pinned (size or hash).
    Mismatch(&'static str),
    Archive(String),
    Io(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Cancelled => write!(f, "the download was cancelled"),
            InstallError::Network(m) => write!(f, "could not download Codex: {m}"),
            InstallError::Timeout => write!(f, "the download of Codex stalled or took too long"),
            InstallError::Mismatch(what) => write!(
                f,
                "the downloaded Codex did not match what Sanctum expects ({what}), so it was deleted"
            ),
            InstallError::Archive(m) => write!(f, "could not unpack Codex: {m}"),
            InstallError::Io(m) => write!(f, "could not save Codex: {m}"),
        }
    }
}

impl std::error::Error for InstallError {}

fn io<E: std::fmt::Display>(e: E) -> InstallError {
    InstallError::Io(e.to_string())
}

/// Hosts a release download may be sent to.
fn host_ok(u: &Url) -> bool {
    u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str().is_some_and(|h| {
            h == "github.com"
                || h == "githubusercontent.com"
                || h.ends_with(".githubusercontent.com")
        })
}

/// Removes leftovers of a download that was interrupted.
fn clean_partials(bin_dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(bin_dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(".dl-") || name.starts_with(".unpack-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Downloads `rel` into `archive`, checking size, hash and hosts. `progress(done, total)` is
/// called as data arrives.
async fn download(
    transport: &dyn Transport,
    rel: &Release,
    archive: &Path,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), InstallError> {
    let pin = &rel.pin;
    let start = check_url(&pin.url, true).map_err(|e| InstallError::Network(e.to_string()))?;
    if !host_ok(&start) || start.host_str() != Some("github.com") {
        return Err(InstallError::Network(
            "the pinned address is not on github.com".into(),
        ));
    }
    let mut current = start;
    let mut hops = 0u8;
    let mut response = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(InstallError::Cancelled);
        }
        let r = transport
            .get(&current)
            .await
            .map_err(InstallError::Network)?;
        match r.status {
            200 => break r,
            301 | 302 | 303 | 307 | 308 => {
                hops += 1;
                if hops > MAX_REDIRECTS {
                    return Err(InstallError::Network("too many redirects".into()));
                }
                let loc = r
                    .location
                    .ok_or_else(|| InstallError::Network("a redirect without an address".into()))?;
                let next = current
                    .join(&loc)
                    .map_err(|e| InstallError::Network(e.to_string()))?;
                if !host_ok(&next) {
                    return Err(InstallError::Network(
                        "the download was sent somewhere other than GitHub".into(),
                    ));
                }
                current = next;
            }
            other => {
                return Err(InstallError::Network(format!(
                    "the server answered {other}"
                )))
            }
        }
    };
    if response
        .content_length
        .is_some_and(|l| l != pin.archive_size)
    {
        return Err(InstallError::Mismatch("size"));
    }

    let mut file = std::fs::File::create(archive).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut reported = 0u64;
    let step = (pin.archive_size / 100).max(1);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(InstallError::Cancelled);
        }
        let chunk = tokio::time::timeout(STALL_TIMEOUT, response.body.next_chunk())
            .await
            .map_err(|_| InstallError::Timeout)?
            .map_err(InstallError::Network)?;
        let Some(bytes) = chunk else { break };
        done += bytes.len() as u64;
        if done > pin.archive_size {
            return Err(InstallError::Mismatch("size"));
        }
        hasher.update(&bytes);
        file.write_all(&bytes).map_err(io)?;
        if done - reported >= step {
            reported = done;
            progress(done, pin.archive_size);
        }
    }
    file.flush().map_err(io)?;
    if done != pin.archive_size {
        return Err(InstallError::Mismatch("size"));
    }
    if hex::encode(hasher.finalize()) != pin.archive_sha256 {
        return Err(InstallError::Mismatch("checksum"));
    }
    progress(done, pin.archive_size);
    Ok(())
}

/// Takes the one pinned file out of the archive into `out`, and checks it. The archive's own
/// paths are never used.
fn unpack(archive: &Path, out: &Path, pin: &Pin) -> Result<(), InstallError> {
    let f = std::fs::File::open(archive).map_err(io)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let entries = tar
        .entries()
        .map_err(|e| InstallError::Archive(e.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| InstallError::Archive(e.to_string()))?;
        let is_it = entry.header().entry_type().is_file()
            && entry
                .path()
                .is_ok_and(|p| p.to_str() == Some(pin.entry.as_str()));
        if !is_it {
            continue;
        }
        let mut dest = std::fs::File::create(out).map_err(io)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        // One byte more than expected, so a larger file is noticed rather than cut short.
        let mut src = entry.take(pin.size + 1);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = src
                .read(&mut buf)
                .map_err(|e| InstallError::Archive(e.to_string()))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            hasher.update(&buf[..n]);
            dest.write_all(&buf[..n]).map_err(io)?;
        }
        dest.flush().map_err(io)?;
        if total != pin.size {
            return Err(InstallError::Mismatch("size"));
        }
        if hex::encode(hasher.finalize()) != pin.sha256 {
            return Err(InstallError::Mismatch("checksum"));
        }
        return Ok(());
    }
    Err(InstallError::Archive(
        "the program was not in the download".into(),
    ))
}

/// Downloads, checks and installs `rel` under `bin_dir`. Returns the path of the program.
/// Does nothing but return the path if the right program is already installed.
pub async fn install(
    transport: &dyn Transport,
    bin_dir: &Path,
    rel: &Release,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<PathBuf, InstallError> {
    let final_path = binary_path(bin_dir, rel);
    if is_present(bin_dir, rel) && verify(bin_dir, rel).await {
        return Ok(final_path);
    }
    std::fs::create_dir_all(bin_dir).map_err(io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(bin_dir, std::fs::Permissions::from_mode(0o700));
    }
    clean_partials(bin_dir);

    let id = uuid::Uuid::new_v4();
    let archive = bin_dir.join(format!(".dl-{id}"));
    let unpacked = bin_dir.join(format!(".unpack-{id}"));
    let result: Result<(), InstallError> = async {
        tokio::time::timeout(
            TOTAL_TIMEOUT,
            download(transport, rel, &archive, cancel, progress),
        )
        .await
        .map_err(|_| InstallError::Timeout)??;
        if cancel.load(Ordering::SeqCst) {
            return Err(InstallError::Cancelled);
        }
        let (a, u, p) = (archive.clone(), unpacked.clone(), rel.pin.clone());
        tokio::task::spawn_blocking(move || unpack(&a, &u, &p))
            .await
            .map_err(|e| InstallError::Io(e.to_string()))??;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unpacked, std::fs::Permissions::from_mode(0o755))
                .map_err(io)?;
        }
        let dir = final_path.parent().expect("has a parent");
        std::fs::create_dir_all(dir).map_err(io)?;
        let _ = std::fs::remove_file(&final_path);
        std::fs::rename(&unpacked, &final_path).map_err(io)?;
        Ok(())
    }
    .await;
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_file(&unpacked);
    result?;

    // An older version is no longer needed.
    if let Ok(rd) = std::fs::read_dir(bin_dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy() != rel.version && e.path().is_dir() {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(final_path)
}

#[cfg(test)]
pub(crate) mod testing {
    //! Helpers shared with the command tests.
    use super::*;

    pub const URL: &str =
        "https://github.com/openai/codex/releases/download/rust-v9.9.9/codex-test.tar.gz";
    pub const CDN: &str =
        "https://release-assets.githubusercontent.com/abc/codex-test.tar.gz?sig=1";

    pub fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("sanctum-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Names are written into the header as they are, so hostile ones (`..`, absolute) can be
    /// tested; the tar crate refuses to build those through `set_path`.
    pub fn targz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        for (name, data) in entries {
            let mut h = tar::Header::new_old();
            h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            h.set_cksum();
            b.append(&h, *data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    pub fn sha(b: &[u8]) -> String {
        hex::encode(Sha256::digest(b))
    }

    /// A release whose pin matches `program` inside `archive`.
    pub fn release(program: &[u8], archive: &[u8]) -> Release {
        Release {
            version: "9.9.9".into(),
            pin: Pin {
                url: URL.into(),
                archive_sha256: sha(archive),
                archive_size: archive.len() as u64,
                entry: "codex-test".into(),
                file: "codex".into(),
                sha256: sha(program),
                size: program.len() as u64,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::registry::fetch::testing::{Mock, Script};
    use std::sync::atomic::AtomicU64;

    const PROGRAM: &[u8] = b"#!/bin/sh\necho pretend codex\n";

    fn served() -> (Vec<u8>, Release, Mock) {
        let archive = targz(&[("README", b"hi"), ("codex-test", PROGRAM)]);
        let rel = release(PROGRAM, &archive);
        let mock = Mock::new();
        mock.route(URL, Script::Redirect(302, CDN.into()));
        mock.serve(CDN, &archive);
        (archive, rel, mock)
    }

    fn no_progress() -> impl Fn(u64, u64) + Send + Sync {
        |_, _| {}
    }

    #[tokio::test]
    async fn downloads_checks_unpacks_and_installs() {
        let (_a, rel, mock) = served();
        let d = dir();
        let last = AtomicU64::new(0);
        let cancel = AtomicBool::new(false);
        let path = install(&mock, &d, &rel, &cancel, &|done, total| {
            assert!(done <= total);
            last.store(done, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert_eq!(path, d.join("9.9.9/codex"));
        assert_eq!(std::fs::read(&path).unwrap(), PROGRAM);
        assert_eq!(last.load(Ordering::SeqCst), rel.pin.archive_size);
        assert!(is_present(&d, &rel));
        assert!(verify(&d, &rel).await);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        // No temporary files are left behind.
        let left: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(left.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn an_installed_program_is_not_downloaded_again() {
        let (_a, rel, mock) = served();
        let d = dir();
        let c = AtomicBool::new(false);
        install(&mock, &d, &rel, &c, &no_progress()).await.unwrap();
        let before = mock.call_count();
        install(&mock, &d, &rel, &c, &no_progress()).await.unwrap();
        assert_eq!(mock.call_count(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_program_changed_on_disk_is_replaced() {
        let (_a, rel, mock) = served();
        let d = dir();
        let c = AtomicBool::new(false);
        let path = install(&mock, &d, &rel, &c, &no_progress()).await.unwrap();
        // Same length, different content: only the hash can tell.
        let mut evil = PROGRAM.to_vec();
        evil[12] ^= 1;
        std::fs::write(&path, &evil).unwrap();
        assert!(is_present(&d, &rel));
        assert!(!verify(&d, &rel).await);
        let before = mock.call_count();
        install(&mock, &d, &rel, &c, &no_progress()).await.unwrap();
        assert!(mock.call_count() > before);
        assert_eq!(std::fs::read(&path).unwrap(), PROGRAM);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_download_with_the_wrong_checksum_is_refused_and_deleted() {
        let (archive, mut rel, mock) = served();
        rel.pin.archive_sha256 = sha(b"something else");
        let d = dir();
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert_eq!(e, InstallError::Mismatch("checksum"));
        assert!(!d.join("9.9.9").exists());
        assert!(std::fs::read_dir(&d).unwrap().next().is_none());
        let _ = archive;
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_download_of_the_wrong_size_is_refused() {
        let (archive, rel, mock) = served();
        // Longer than pinned.
        let mut longer = archive.clone();
        longer.push(0);
        mock.serve(CDN, &longer);
        let d = dir();
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert_eq!(e, InstallError::Mismatch("size"));
        // Shorter than pinned, with an honest length.
        mock.serve(CDN, &archive[..archive.len() - 3]);
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert_eq!(e, InstallError::Mismatch("size"));
        // A server that lies about the length and streams too much is cut off.
        mock.route(
            CDN,
            Script::Chunks {
                declared_len: None,
                chunks: vec![archive.clone(), vec![0u8; 1000]],
                delay: Duration::ZERO,
            },
        );
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert_eq!(e, InstallError::Mismatch("size"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_redirect_away_from_github_is_refused() {
        let (_a, rel, mock) = served();
        for bad in [
            "https://evil.example.com/codex.tar.gz",
            "https://githubusercontent.com.evil.example/codex.tar.gz",
            "http://objects.githubusercontent.com/codex.tar.gz",
            "https://user:pw@objects.githubusercontent.com/codex.tar.gz",
        ] {
            mock.route(URL, Script::Redirect(302, bad.into()));
            let d = dir();
            let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
                .await
                .unwrap_err();
            assert!(matches!(e, InstallError::Network(_)), "{bad}: {e:?}");
            assert!(
                !mock
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|c| c.contains("evil")),
                "{bad}"
            );
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[tokio::test]
    async fn a_pinned_address_off_github_is_refused_before_any_request() {
        let (_a, mut rel, mock) = served();
        rel.pin.url = "https://evil.example.com/codex.tar.gz".into();
        let d = dir();
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert!(matches!(e, InstallError::Network(_)));
        assert_eq!(mock.call_count(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn only_the_pinned_entry_is_used_whatever_the_archive_says() {
        // A hostile archive with path tricks and the real entry too.
        let archive = targz(&[
            ("../../escape", b"x"),
            ("/abs/escape", b"x"),
            ("codex-test/../codex-test", b"not it"),
            ("codex-test", PROGRAM),
        ]);
        let rel = release(PROGRAM, &archive);
        let mock = Mock::new();
        mock.serve(URL, &archive);
        let d = dir();
        let outer = d.join("outer");
        let path = install(&mock, &outer, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), PROGRAM);
        assert!(!d.join("escape").exists());
        assert!(!std::path::Path::new("/abs/escape").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn an_archive_without_the_program_or_with_a_different_one_is_refused() {
        let d = dir();
        // Missing.
        let archive = targz(&[("README", b"hi")]);
        let rel = release(PROGRAM, &archive);
        let mock = Mock::new();
        mock.serve(URL, &archive);
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert!(matches!(e, InstallError::Archive(_)), "{e:?}");
        // Right archive hash, but the program inside is not the pinned one.
        // Same length as the pinned program, so only the hash can tell them apart.
        let mut other = PROGRAM.to_vec();
        other[12] ^= 1;
        let archive = targz(&[("codex-test", other.as_slice())]);
        let mut rel = release(PROGRAM, &archive);
        rel.pin.archive_sha256 = sha(&archive);
        let mock = Mock::new();
        mock.serve(URL, &archive);
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert!(matches!(e, InstallError::Mismatch(_)), "{e:?}");
        assert!(!d.join("9.9.9/codex").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn cancelling_stops_the_download_and_leaves_nothing() {
        let (archive, rel, mock) = served();
        mock.route(
            CDN,
            Script::Chunks {
                declared_len: Some(archive.len() as u64),
                chunks: archive.chunks(8).map(<[u8]>::to_vec).collect(),
                delay: Duration::from_millis(5),
            },
        );
        let d = dir();
        let cancel = AtomicBool::new(false);
        let seen = AtomicU64::new(0);
        let on_progress = |done: u64, _total: u64| {
            seen.store(done, Ordering::SeqCst);
            cancel.store(true, Ordering::SeqCst);
        };
        let e = install(&mock, &d, &rel, &cancel, &on_progress)
            .await
            .unwrap_err();
        assert_eq!(e, InstallError::Cancelled);
        assert!(seen.load(Ordering::SeqCst) < archive.len() as u64);
        assert!(std::fs::read_dir(&d).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_stalled_server_is_given_up_on() {
        tokio::time::pause();
        let (archive, rel, mock) = served();
        mock.route(
            CDN,
            Script::Chunks {
                declared_len: Some(archive.len() as u64),
                chunks: vec![archive[..4].to_vec(), archive[4..].to_vec()],
                delay: Duration::from_secs(3600),
            },
        );
        let d = dir();
        let e = install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap_err();
        assert_eq!(e, InstallError::Timeout);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn an_older_version_is_removed_after_a_new_one_is_installed() {
        let (_a, rel, mock) = served();
        let d = dir();
        std::fs::create_dir_all(d.join("0.1.0")).unwrap();
        std::fs::write(d.join("0.1.0/codex"), b"old").unwrap();
        install(&mock, &d, &rel, &AtomicBool::new(false), &no_progress())
            .await
            .unwrap();
        assert!(!d.join("0.1.0").exists());
        assert!(d.join("9.9.9/codex").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── The real pins ─────────────────────────────────────────────────────────────────

    #[test]
    fn the_checked_in_pins_are_well_formed_and_match_the_schema_version() {
        let f = pin_file();
        for key in [
            "macos-aarch64",
            "macos-x86_64",
            "linux-aarch64",
            "linux-x86_64",
            "windows-x86_64",
        ] {
            let p = f
                .pins
                .get(key)
                .unwrap_or_else(|| panic!("{key} is not pinned"));
            let u = Url::parse(&p.url).unwrap();
            assert_eq!(u.host_str(), Some("github.com"), "{key}");
            assert!(
                u.path().starts_with(&format!(
                    "/openai/codex/releases/download/rust-v{}/",
                    f.version
                )),
                "{key}: {}",
                p.url
            );
            for h in [&p.archive_sha256, &p.sha256] {
                assert_eq!(h.len(), 64, "{key}");
                assert!(h.bytes().all(|b| b.is_ascii_hexdigit()), "{key}");
            }
            assert!(
                p.archive_size > 1_000_000 && p.size > p.archive_size,
                "{key}"
            );
            // The names are plain: nothing that could be a path.
            for n in [&p.entry, &p.file] {
                assert!(!n.is_empty() && !n.contains(['/', '\\']), "{key}: {n}");
            }
        }
        // The protocol schema we test against must be the one of the version we download.
        let v = include_str!("../../../spec/codex-app-server/VERSION");
        assert!(
            v.starts_with(&format!("codex-cli {}\n", f.version)),
            "spec/codex-app-server/VERSION says {v:?} but the pins are for {}",
            f.version
        );
    }
}
