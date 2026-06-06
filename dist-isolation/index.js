/**
 * Tauri Isolation Pattern — IPC hook (v0: passthrough).
 *
 * Called for every IPC message from the host UI before it reaches Tauri Core.
 * The payload is AES-GCM encrypted by the framework with a per-session key;
 * the hook receives the plaintext, can inspect/modify/reject it, then returns
 * it and the framework encrypts the result before sending to Core.
 *
 * v0: trust all messages from the host UI — pass through unchanged.
 *
 * v1 plan: inspect `payload.cmd` for device-access commands (camera:open,
 * usb:request-device, etc.) originating from tool windows and route them
 * through the device_broker consent flow instead of forwarding directly.
 *
 * @param {object} payload - The IPC payload (cmd, args, etc.)
 * @returns {object} The (possibly modified) payload to forward to Core.
 */
window.__TAURI_ISOLATION_HOOK__ = function (payload) {
  // v0-todo(v1): inspect payload.cmd; if it comes from a tool window and
  // requests a device capability, redirect to device_broker rather than
  // forwarding. Tool windows don't have IPC capabilities in v0, so this
  // hook only fires for the host UI.
  return payload;
};
