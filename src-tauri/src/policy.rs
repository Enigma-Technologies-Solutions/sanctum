// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

/// v2 stub — enterprise / org policy engine.
///
/// In v2, organisations deploy a policy file (JSON or TOML) that Sanctum
/// reads on startup. The policy controls:
///
///   • Allowed / denied capability sets per tool or publisher
///   • Required minimum trust level (unsigned < community-signed < org-signed)
///   • Pinned publisher public keys (Ed25519)
///   • Block-unsigned: refuse to run tools without a valid signature
///   • Registry allow/deny-lists: only permit tools from approved registries
///
/// Planned structure (not yet implemented):
///
/// ```json
/// {
///   "schema_version": 1,
///   "block_unsigned": true,
///   "allowed_publishers": ["ed25519:ABC..."],
///   "denied_capabilities": ["usb", "serial", "hid"],
///   "registry": {
///     "allow": ["https://registry.sanctum.app"],
///     "require_sbom": true
///   }
/// }
/// ```
///
/// Policy is read-only from Sanctum's perspective — written by IT/admins,
/// possibly via MDM. Sanctum enforces it; it does not edit it.
pub struct PolicyStub;
