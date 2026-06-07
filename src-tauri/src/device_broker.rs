// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

/// v1 stub — device access broker.
///
/// In v1 this module becomes the single choke-point for all hardware access.
/// Tools cannot contact hardware directly; they must request a capability via
/// IPC, which routes through here, triggers OS permission dialogs, and
/// requires explicit user consent before granting the resource handle.
///
/// Planned interface (not yet implemented):
///
/// ```rust,ignore
/// pub enum DeviceRequest {
///     Camera { label: String },
///     Microphone { label: String },
///     UsbDevice { vendor_id: u16, product_id: u16 },
///     SerialPort { path: String },
///     HidDevice { usage_page: u16, usage: u16 },
///     Bluetooth { service_uuid: String },
/// }
///
/// pub struct ConsentRecord {
///     pub tool_id: String,
///     pub request: DeviceRequest,
///     pub granted_at: i64,
///     pub expires_at: Option<i64>,
/// }
///
/// /// Prompt the user for consent and, if granted, return an opaque handle
/// /// the tool can use for the lifetime of its window.
/// pub async fn request_device(
///     app: &tauri::AppHandle,
///     tool_id: &str,
///     request: DeviceRequest,
/// ) -> Result<DeviceHandle, DeviceBrokerError> { ... }
/// ```
pub struct DeviceBrokerStub;
