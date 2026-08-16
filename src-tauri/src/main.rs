// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

// Hides the console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Work around WebKitGTK's DMABUF renderer producing torn, banded garbage
/// instead of a UI.
///
/// WebKitGTK 2.40+ shares render buffers with the compositor through DMABUF.
/// Where that path is not solid — the Raspberry Pi's V3D driver, VMs with
/// virtualised GL, some NVIDIA proprietary setups — the window paints as
/// horizontal streaks. Nothing in the app can detect this after the fact: the
/// page renders correctly and the buffers arrive corrupted.
///
/// Turning the renderer off costs a buffer copy on machines that would have
/// been fine, which for a mostly-static UI is not measurable, so this is a
/// straight trade of a little throughput for a window that is never garbage.
/// An explicit setting from the environment always wins, so anyone who wants
/// the fast path can `WEBKIT_DISABLE_DMABUF_RENDERER=0`.
///
/// Must run before GTK or WebKit initialise, hence its position at the top of
/// main rather than inside the Tauri setup hook.
#[cfg(target_os = "linux")]
fn apply_webkit_rendering_workarounds() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: single-threaded — nothing else has started yet.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    apply_webkit_rendering_workarounds();

    sanctum_lib::run();
}
