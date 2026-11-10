/// Every command in `tauri::generate_handler!` (src/lib.rs), declared here so Tauri checks
/// them against the capability files.
///
/// Without this list Tauri does not check app commands at all for a window on a local origin,
/// and `sanctum-tool://` counts as local. Tool windows would then be kept away from these
/// commands only by the isolation pattern's encryption, not by any permission. With the list,
/// a command runs only in a window whose capability grants `allow-<command>`, and
/// `capabilities/tool-default.json` grants nothing. A test in `lib.rs` fails if a command is
/// added to the handler but not here.
const APP_COMMANDS: &[&str] = &[
    "ingest_html",
    "ingest_from_clipboard",
    "ingest_from_path",
    "ingest_bundle_from_path",
    "get_provenance",
    "get_policy_status",
    "get_trust_anchors",
    "list_registries",
    "add_registry",
    "refresh_registry",
    "check_registries",
    "registry_notices",
    "remove_registry",
    "registry_catalogue",
    "registry_app_detail",
    "install_from_registry",
    "install_all_from_registry",
    "take_pending_link",
    "agent_setup",
    "agent_set_enabled",
    "agent_account",
    "agent_sign_in",
    "agent_cancel_sign_in",
    "agent_sign_out",
    "agent_open_create_window",
    "agent_chat_start",
    "agent_chat_send",
    "agent_scan_draft",
    "agent_add_draft",
    "agent_preview_draft",
    "agent_draft_history",
    "agent_restore_draft",
    "agent_get_instructions",
    "agent_set_instructions",
    "agent_chat_stop",
    "agent_chat_close",
    "list_tools",
    "get_tool",
    "update_metadata",
    "create_version",
    "compute_checksum",
    "rollback_version",
    "scan_capabilities",
    "capabilities_for_manifest",
    "open_tool_window",
    "update_approvals",
    "delete_tool",
    "update_tool_from_clipboard",
    "update_tool_from_path",
    "check_for_update",
    "install_update",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("tauri build step failed");
}
