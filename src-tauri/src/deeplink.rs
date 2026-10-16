// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Receiving `sanctum://install` links.
//!
//! The operating system hands a link to the running (or starting) Sanctum. This module
//! validates it with [`crate::registry::link`], remembers the result and tells the main
//! window. It does **nothing else**: no request is made, nothing is installed, and no
//! approval is touched. The window shows a confirmation and only a click there goes on.
//!
//! Only this Rust side receives links. No capability file grants `deep-link:*`, so no webview
//! can read or register links itself.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::registry::link::{to_event, LinkEvent, SCHEME};

/// Event the window listens for.
pub const LINK_EVENT: &str = "registry-link";

/// At most this many arguments are looked at when a second launch hands over its command
/// line, so a long argument list cannot make us scan forever.
const MAX_ARGS: usize = 16;

/// The newest link that has not been shown yet. The window takes it when it is ready, which
/// covers a link that started the app before the window could listen.
#[derive(Default)]
pub struct PendingLink(pub Mutex<Option<LinkEvent>>);

fn is_sanctum_url(s: &str) -> bool {
    s.len() > SCHEME.len()
        && s.get(..SCHEME.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(SCHEME))
        && s[SCHEME.len()..].starts_with(':')
}

/// Of everything the OS passed in, the one link to act on: the first that uses our scheme.
/// Other arguments (the program path, flags) are ignored. Only one request is handled at a
/// time, so a burst of links cannot stack up dialogs.
pub fn first_event<S: AsRef<str>>(args: &[S]) -> Option<LinkEvent> {
    args.iter()
        .take(MAX_ARGS)
        .map(AsRef::as_ref)
        .find(|a| is_sanctum_url(a))
        .map(to_event)
}

/// Remember `event` (replacing an older one) and tell the main window.
pub fn deliver(app: &AppHandle, event: LinkEvent) {
    if let Some(pending) = app.try_state::<PendingLink>() {
        *pending.0.lock().unwrap() = Some(event.clone());
    }
    // An ignored error here only means the window is not listening yet; the pending slot
    // above is how it catches up.
    let _ = app.emit_to("main", LINK_EVENT, &event);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Entry point for both "the OS opened a link" and "a second launch passed arguments".
pub fn handle_args<S: AsRef<str>>(app: &AppHandle, args: &[S]) {
    if let Some(event) = first_event(args) {
        deliver(app, event);
    }
}

/// The window asks for a link that arrived before it was listening, and clears it. Taking it
/// is what makes a link show once: reloading the window does not show it again.
#[tauri::command]
pub fn take_pending_link(state: tauri::State<'_, PendingLink>) -> Option<LinkEvent> {
    take(&state)
}

fn take(p: &PendingLink) -> Option<LinkEvent> {
    p.0.lock().unwrap().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "sanctum://install?app=sh.enigma.shamir";

    #[test]
    fn takes_the_first_sanctum_link_and_ignores_other_arguments() {
        let args = [
            "/Applications/Sanctum",
            "--flag",
            GOOD,
            "sanctum://install?app=sh.enigma.otp-vault",
        ];
        match first_event(&args) {
            Some(LinkEvent::Install { request }) => assert_eq!(request.app_id, "sh.enigma.shamir"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_link_means_nothing_happens() {
        assert!(first_event::<&str>(&[]).is_none());
        assert!(first_event(&["/path/to/Sanctum", "--debug"]).is_none());
        assert!(first_event(&["https://sanctum.enigma.sh/"]).is_none());
        assert!(first_event(&["sanctumx://install?app=sh.enigma.shamir"]).is_none());
        assert!(first_event(&["sanctum"]).is_none());
    }

    #[test]
    fn the_scheme_is_matched_without_regard_to_case() {
        assert!(matches!(
            first_event(&["SANCTUM://install?app=sh.enigma.shamir"]),
            Some(LinkEvent::Install { .. })
        ));
    }

    #[test]
    fn a_bad_link_is_reported_not_dropped() {
        // The person clicked something; they should hear that Sanctum refused it.
        assert!(matches!(
            first_event(&["sanctum://install"]),
            Some(LinkEvent::Refused { .. })
        ));
        assert!(matches!(
            first_event(&["sanctum://evil?app=x"]),
            Some(LinkEvent::Refused { .. })
        ));
    }

    #[test]
    fn only_the_first_link_is_acted_on() {
        let args = ["sanctum://install", GOOD];
        assert!(
            matches!(first_event(&args), Some(LinkEvent::Refused { .. })),
            "the second link must not be used"
        );
    }

    #[test]
    fn a_link_far_down_a_long_argument_list_is_not_scanned_for() {
        let mut args: Vec<String> = (0..MAX_ARGS).map(|i| format!("--arg{i}")).collect();
        args.push(GOOD.to_string());
        assert!(first_event(&args).is_none());
        let mut args: Vec<String> = (0..MAX_ARGS - 1).map(|i| format!("--arg{i}")).collect();
        args.push(GOOD.to_string());
        assert!(first_event(&args).is_some());
    }

    #[test]
    fn a_pending_link_is_shown_once() {
        let p = PendingLink::default();
        *p.0.lock().unwrap() = first_event(&[GOOD]);
        assert!(take(&p).is_some());
        assert!(take(&p).is_none());
    }
}
