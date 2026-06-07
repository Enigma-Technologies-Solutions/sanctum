// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

/// v3 stub — tool registry client.
///
/// The registry provides server-side provenance for tools: checksum + scan
/// result + signature + publisher identity, computed on the server and
/// cached locally. A tool is "registry-verified" when its checksum appears
/// in the registry with a valid signature from a known publisher.
///
/// Planned interface (not yet implemented):
///
/// ```rust,ignore
/// pub struct RegistryEntry {
///     pub checksum: String,       // sha256:hex
///     pub publisher: String,      // publisher identifier
///     pub signature: String,      // Ed25519 over (checksum || manifest_hash)
///     pub published_at: i64,
///     pub revoked: bool,
///     pub sbom_url: Option<String>,
/// }
///
/// pub async fn lookup(checksum: &str) -> Result<Option<RegistryEntry>, RegistryError>;
/// pub async fn submit(checksum: &str, manifest: &ToolManifest) -> Result<(), RegistryError>;
/// ```
///
/// In v0 the registry is offline-only; this module is never called.
/// In v3 it runs as a background sync that updates badge states in the library.
pub struct RegistryClientStub;
