// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Registry client: add, refresh, list and remove registries (docs/registry-format.md).
//!
//! Layers, bottom to top:
//!
//! - [`fetch`]: HTTPS-only downloads with size, time and redirect limits. The transport is a
//!   trait so every policy can be tested without a network.
//! - `sanctum_bundle::registry`: verification of what was downloaded. Nothing is parsed
//!   before the signature checks out.
//! - [`store`]: the `registries` table, holding the verified bytes so the catalogue works
//!   offline. The cache is verified again on use, never trusted.
//! - [`client`]: the rules (trust on add, rollback protection, what a failed refresh may and
//!   may not change).
//! - [`commands`]: the Tauri commands.
//!
//! Rules this module must keep:
//!
//! 1. **A registry never grants a capability.** Nothing here installs a tool. Phase 5 will,
//!    through the normal bundle verification, scan and approval screen.
//! 2. **Network requests happen only when the user asks** (add or refresh). There is no
//!    background timer yet. The privacy copy on the website says the update check is the
//!    only request Sanctum makes by itself; keep that true, or change the copy first.
//! 3. **A bad registry cannot poison a good cached one.** A refresh that fails any check
//!    changes nothing but a "last error" note.
//! 4. **No telemetry.** Requests carry no identifiers, only the fixed user agent "Sanctum".

pub mod client;
pub mod commands;
pub mod detail;
pub mod fetch;
pub mod install;
pub mod store;
