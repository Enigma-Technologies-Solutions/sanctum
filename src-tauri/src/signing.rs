// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Signature verification lives in the `sanctum-bundle` crate (`crates/sanctum-bundle`), so
//! the app and the signing CLI share one implementation. The install path is in
//! `commands/bundle.rs`; compiled-in anchors are in `trust.rs`; the design and the rules
//! it is held to are in `docs/registry.md`.
//!
//! This module used to hold a `verify_signature(&ToolManifest)` stub that could only ever
//! return "unsigned". It was never called and has been removed: `ToolManifest` is derived
//! locally at install time, so it is the wrong thing to sign (the publisher's version and
//! declared capabilities live in a separate signed statement).

pub use sanctum_bundle::{Trust, Verification, VerifyError};
