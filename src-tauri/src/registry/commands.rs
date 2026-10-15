// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Tauri commands for registries. Thin: every rule lives in `client.rs`.
//!
//! These run only when the user acts (add, refresh, remove, list). There is no background
//! polling. Tool windows have no IPC at all, so a tool cannot call any of this.

use super::client::{ClientError, RefreshReport, RegistryClient, RegistrySummary};
use serde::Serialize;
use tauri::State;

/// The managed state. The client is optional so that a failure to set up TLS disables the
/// registry feature with a clear message instead of stopping the whole app.
pub struct RegistryState {
    pub client: Result<RegistryClient, String>,
}

/// An error the interface can act on: `code` is stable, `message` is for people, and the
/// signer fields are filled when the user may choose to pin a key.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub signer: Option<String>,
    pub registry_id: Option<String>,
    pub registry_name: Option<String>,
}

impl From<ClientError> for CommandError {
    fn from(e: ClientError) -> Self {
        let (signer, registry_id, registry_name) = match &e {
            ClientError::UntrustedSigner {
                signer,
                registry_id,
                registry_name,
            } => (
                Some(signer.clone()),
                Some(registry_id.clone()),
                Some(registry_name.clone()),
            ),
            ClientError::SignerChanged { signer } => (Some(signer.clone()), None, None),
            _ => (None, None, None),
        };
        CommandError {
            code: e.code().to_string(),
            message: e.to_string(),
            signer,
            registry_id,
            registry_name,
        }
    }
}

fn client(state: &RegistryState) -> Result<&RegistryClient, CommandError> {
    state.client.as_ref().map_err(|m| CommandError {
        code: "unavailable".into(),
        message: format!("Registries are unavailable on this system: {m}"),
        signer: None,
        registry_id: None,
        registry_name: None,
    })
}

#[tauri::command]
pub async fn list_registries(
    state: State<'_, RegistryState>,
) -> Result<Vec<RegistrySummary>, CommandError> {
    Ok(client(&state)?.list().await?)
}

/// Add a registry by address. `pinned_key` is a signer key the user chose to trust, sent only
/// after an `untrusted_signer` error showed it to them.
#[tauri::command]
pub async fn add_registry(
    state: State<'_, RegistryState>,
    url: String,
    pinned_key: Option<String>,
) -> Result<RegistrySummary, CommandError> {
    Ok(client(&state)?.add(&url, pinned_key.as_deref()).await?)
}

#[tauri::command]
pub async fn refresh_registry(
    state: State<'_, RegistryState>,
    id: String,
) -> Result<RefreshReport, CommandError> {
    Ok(client(&state)?.refresh(&id).await?)
}

#[tauri::command]
pub async fn remove_registry(
    state: State<'_, RegistryState>,
    id: String,
) -> Result<(), CommandError> {
    Ok(client(&state)?.remove(&id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::fetch::FetchError;

    #[test]
    fn an_untrusted_signer_error_carries_what_the_interface_must_show() {
        let e: CommandError = ClientError::UntrustedSigner {
            signer: "ed25519:abc".into(),
            registry_id: "registry:x.y".into(),
            registry_name: "Example".into(),
        }
        .into();
        assert_eq!(e.code, "untrusted_signer");
        assert_eq!(e.signer.as_deref(), Some("ed25519:abc"));
        assert_eq!(e.registry_name.as_deref(), Some("Example"));
        let v = serde_json::to_value(&e).unwrap();
        for k in ["code", "message", "signer", "registryId", "registryName"] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
    }

    #[test]
    fn other_errors_carry_only_a_code_and_a_message() {
        let e: CommandError = ClientError::Fetch(FetchError::Insecure).into();
        assert_eq!(e.code, "insecure_url");
        assert!(e.message.contains("https"));
        assert!(e.signer.is_none() && e.registry_id.is_none());
    }

    #[test]
    fn an_unavailable_client_says_so() {
        let state = RegistryState {
            client: Err("no TLS".into()),
        };
        let e = client(&state).err().unwrap();
        assert_eq!(e.code, "unavailable");
        assert!(e.message.contains("no TLS"));
    }
}
