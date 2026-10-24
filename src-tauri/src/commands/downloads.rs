// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Files a tool saves.
//!
//! A tool cannot write to the disk. What it can do is build a file in memory and click a link
//! with a `download` name, as any web page does. Left to the webview, what happens then differs
//! by platform (some cancel it, some pick a folder), so Sanctum decides it once, here: the file
//! goes to the person's Downloads folder, never anywhere else, and the operating system still
//! marks it as downloaded.
//!
//! This needs no approval, as in a browser, because it is narrow: the folder is fixed, the name
//! is cleaned, a file never replaces another, programs and scripts are refused, and a window may
//! save only a handful. A tool that is not approved for anything can still hand the person a
//! file, and the person still has to open it themselves.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Most files one window may save. A page that loops cannot fill the folder.
pub const MAX_PER_WINDOW: usize = 25;

/// Longest file name kept, extension included.
const MAX_NAME_CHARS: usize = 120;

/// Extensions of things that run when opened. A tool cannot save these.
const REFUSED: &[&str] = &[
    "app", "command", "sh", "bash", "zsh", "csh", "ksh", "fish", "pkg", "dmg", "mpkg", "exe",
    "msi", "msp", "bat", "cmd", "com", "scr", "pif", "ps1", "psm1", "psd1", "vbs", "vbe", "js",
    "jse", "wsf", "wsh", "hta", "cpl", "dll", "sys", "lnk", "reg", "jar", "py", "pl", "rb", "php",
    "appimage", "deb", "rpm", "run", "desktop", "workflow", "action", "scpt", "terminal", "url",
    "webloc", "inetloc", "iso", "img", "apk", "msix", "appx", "gadget", "ws", "chm",
];

/// The name to save under, or `None` when the file is refused. Keeps the last path part only,
/// drops control characters and the characters file systems reject, trims dots and spaces, and
/// shortens it.
pub fn safe_name(requested: &str) -> Option<String> {
    let last = requested.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        return None;
    }
    // Every dot-separated part after the first is checked, so `report.pdf.exe` and
    // `report.exe.pdf` are both looked at.
    let mut parts = trimmed.split('.');
    parts.next();
    if parts.any(|p| REFUSED.contains(&p.to_ascii_lowercase().as_str())) {
        return None;
    }
    let name: String = if trimmed.chars().count() > MAX_NAME_CHARS {
        let (stem, ext) = match trimmed.rsplit_once('.') {
            Some((s, e)) if e.chars().count() <= 12 => (s, format!(".{e}")),
            _ => (trimmed, String::new()),
        };
        let keep = MAX_NAME_CHARS.saturating_sub(ext.chars().count());
        format!("{}{ext}", stem.chars().take(keep).collect::<String>())
    } else {
        trimmed.to_owned()
    };
    Some(name)
}

/// `name`, or `name (1)`, `name (2)` and so on until nothing of that name is in `dir`.
fn free_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let first = dir.join(name);
    if !first.exists() {
        return Some(first);
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (1..1000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
}

/// Whether the page may save from `url`. Only a file the page built itself (`blob:` or `data:`)
/// or one of its own files. Anything else is a navigation to somewhere else wearing a download's
/// clothes.
fn source_ok(url: &url::Url, own_host: &str) -> bool {
    match url.scheme() {
        "data" => true,
        "blob" => url::Url::parse(url.path()).is_ok_and(|inner| own_origin(&inner, own_host)),
        _ => own_origin(url, own_host),
    }
}

fn own_origin(url: &url::Url, own_host: &str) -> bool {
    match url.scheme() {
        "sanctum-tool" => url.host_str() == Some(own_host),
        // Windows and Android serve the scheme over `<scheme>.localhost`; see the note on
        // `is_allowed_tool_navigation`.
        "http" | "https" => url.host_str().is_some_and(|h| h.ends_with(".localhost")),
        _ => false,
    }
}

/// Decides one download request. On `true`, `destination` has been set to a free path inside
/// `downloads_dir`.
pub fn decide(
    url: &url::Url,
    destination: &mut PathBuf,
    downloads_dir: Option<&Path>,
    own_host: &str,
    saved: &AtomicUsize,
) -> bool {
    let Some(dir) = downloads_dir else {
        return false;
    };
    if !source_ok(url, own_host) {
        return false;
    }
    let Some(name) = destination
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(safe_name)
    else {
        return false;
    };
    let Some(path) = free_path(dir, &name) else {
        return false;
    };
    // Counted last, so a refused request does not use up the allowance.
    if saved.fetch_add(1, Ordering::SeqCst) >= MAX_PER_WINDOW {
        saved.fetch_sub(1, Ordering::SeqCst);
        return false;
    }
    *destination = path;
    true
}

/// The handler a tool window uses: `Requested` goes through [`decide`]; other events pass.
pub fn handler<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    own_host: String,
) -> impl Fn(tauri::Webview<R>, tauri::webview::DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    use tauri::Manager;
    let saved = Arc::new(AtomicUsize::new(0));
    move |_webview, event| match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let dir = app.path().download_dir().ok();
            decide(&url, destination, dir.as_deref(), &own_host, &saved)
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sanctum-dl-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const HOST: &str = "tool-abc";

    fn go(u: &str, name: &str, d: &Path, n: &AtomicUsize) -> Option<PathBuf> {
        let mut dest = PathBuf::from("/elsewhere").join(name);
        decide(&url(u), &mut dest, Some(d), HOST, n).then_some(dest)
    }

    #[test]
    fn names_are_cleaned_and_programs_are_refused() {
        assert_eq!(safe_name("report.pdf").as_deref(), Some("report.pdf"));
        assert_eq!(
            safe_name("../../etc/passwd.txt").as_deref(),
            Some("passwd.txt")
        );
        assert_eq!(safe_name("a\\b\\c.csv").as_deref(), Some("c.csv"));
        assert_eq!(safe_name("a:b*c?.txt").as_deref(), Some("a_b_c_.txt"));
        assert_eq!(safe_name("  ..hidden. ").as_deref(), Some("hidden"));
        assert_eq!(safe_name("..."), None);
        assert_eq!(safe_name(""), None);
        for bad in [
            "x.exe",
            "x.EXE",
            "x.pdf.exe",
            "x.exe.pdf",
            "run.sh",
            "x.command",
            "x.app",
            "x.js",
            "x.bat",
            "x.ps1",
        ] {
            assert_eq!(safe_name(bad), None, "{bad}");
        }
        for fine in [
            "notes.txt",
            "page.html",
            "data.json",
            "photo.png",
            "book.xlsx",
            "my.report.v2.pdf",
        ] {
            assert!(safe_name(fine).is_some(), "{fine}");
        }
    }

    #[test]
    fn a_long_name_is_shortened_but_keeps_its_extension() {
        let n = safe_name(&format!("{}.pdf", "a".repeat(300))).unwrap();
        assert_eq!(n.chars().count(), MAX_NAME_CHARS);
        assert!(n.ends_with(".pdf"));
    }

    #[test]
    fn a_file_goes_to_the_downloads_folder_whatever_path_was_asked_for() {
        let d = dir("where");
        let n = AtomicUsize::new(0);
        let p = go(
            "blob:sanctum-tool://tool-abc/1234",
            "../../../x/out.txt",
            &d,
            &n,
        )
        .unwrap();
        assert_eq!(p, d.join("out.txt"));
        let p = go("data:text/plain,hi", "d.txt", &d, &n).unwrap();
        assert_eq!(p, d.join("d.txt"));
        // Windows serves the scheme over a localhost host.
        assert!(go("blob:http://sanctum-tool.localhost/1234", "w.txt", &d, &n).is_some());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_file_never_replaces_another() {
        let d = dir("same");
        let n = AtomicUsize::new(0);
        std::fs::write(d.join("out.txt"), b"mine").unwrap();
        let p = go("blob:sanctum-tool://tool-abc/1", "out.txt", &d, &n).unwrap();
        assert_eq!(p, d.join("out (1).txt"));
        std::fs::write(&p, b"x").unwrap();
        let p = go("blob:sanctum-tool://tool-abc/2", "out.txt", &d, &n).unwrap();
        assert_eq!(p, d.join("out (2).txt"));
        assert_eq!(std::fs::read(d.join("out.txt")).unwrap(), b"mine");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn only_the_pages_own_files_can_be_saved() {
        let d = dir("src");
        let n = AtomicUsize::new(0);
        for u in [
            "https://example.com/a.zip",
            "http://evil.test/a.zip",
            "file:///etc/passwd",
            "sanctum-tool://tool-other/a.txt",
            "blob:sanctum-tool://tool-other/1",
            "blob:https://example.com/1",
        ] {
            assert!(go(u, "a.txt", &d, &n).is_none(), "{u}");
        }
        assert_eq!(n.load(Ordering::SeqCst), 0, "a refusal uses no allowance");
        assert!(go("sanctum-tool://tool-abc/a.txt", "a.txt", &d, &n).is_some());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn programs_are_refused_and_the_allowance_is_bounded() {
        let d = dir("cap");
        let n = AtomicUsize::new(0);
        assert!(go("data:text/plain,x", "evil.exe", &d, &n).is_none());
        assert_eq!(n.load(Ordering::SeqCst), 0);
        for i in 0..MAX_PER_WINDOW {
            let p = go("data:text/plain,x", &format!("f{i}.txt"), &d, &n).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        assert!(go("data:text/plain,x", "one-more.txt", &d, &n).is_none());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn with_no_downloads_folder_nothing_is_saved() {
        let n = AtomicUsize::new(0);
        let mut dest = PathBuf::from("a.txt");
        assert!(!decide(
            &url("data:text/plain,x"),
            &mut dest,
            None,
            HOST,
            &n
        ));
    }
}
