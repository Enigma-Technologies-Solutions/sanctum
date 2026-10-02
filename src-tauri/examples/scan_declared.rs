// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Print the capability list Sanctum's scanner finds in an HTML file, as JSON.
//!
//! This is the value to pass to `sanctum-bundle sign --declared`, so a bundle declares
//! exactly what the app will detect when it installs it.
//!
//!     cargo run --manifest-path src-tauri/Cargo.toml --example scan_declared -- tool.html

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: scan_declared FILE.html");
        std::process::exit(2);
    });
    let html = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("cannot read {path}: {e}");
        std::process::exit(1);
    });
    let caps = sanctum_lib::commands::scan::scan_html(&html);
    println!(
        "{}",
        serde_json::to_string(&caps).expect("capabilities serialise")
    );
}
