# Sanctum — Architecture Reference for HTML Tool Authors

Sanctum is a macOS desktop app that runs AI-generated HTML tools in isolated sandboxes. This document covers everything an HTML tool needs to know to work correctly within Sanctum.

---

## How a Tool Is Loaded

1. **Ingest** — Sanctum accepts HTML via paste from clipboard or file path.
2. **Static scan** — Rust scans the raw HTML for capability signals (API patterns, URL literals). This is advisory only; it drives the permission UI, not security enforcement.
3. **Integrity stamp** — SHA-256 of the file is the version ID. Tampering quarantines the tool permanently.
4. **Approval gate** — The user sees the detected capabilities and approves or denies each one.
5. **Run** — A new WebView window opens, serving the tool from a custom protocol with a dynamically built CSP matching only the approved capabilities.

---

## Origin Model — the Most Important Thing to Understand

Every tool runs at a distinct web origin:

```
sanctum-tool://tool-{uuid}/
```

`{uuid}` is assigned at ingest time and never changes for that tool record. This origin is the tool's permanent address.

**Implications:**

| Concern | Behavior |
|---|---|
| `localStorage` | Scoped to this origin. Persists across runs. Invisible to all other tools. |
| `sessionStorage` | Scoped to this origin. Cleared when the window closes. |
| `indexedDB` | Scoped to this origin. Persists across runs. |
| `document.cookie` | Scoped to this origin. |
| Cross-tool access | Impossible — different UUIDs = different origins = no shared storage. |
| **Reinstall** | **New UUID = new origin = all persisted storage becomes inaccessible.** |

To read your own origin at runtime:
```js
const myOrigin = window.location.origin; // "sanctum-tool://tool-{uuid}"
const myHost   = window.location.hostname; // "tool-{uuid}"
```

---

## What Is Blocked by Default

### No Tauri IPC
An initialization script runs before any tool code and permanently removes all Tauri globals:

```
window.__TAURI__, __TAURI_IPC__, __TAURI_INTERNALS__, __TAURI_INVOKE__, ipc, __TAURI_METADATA__
```

Tools have **zero access to the Tauri/Rust bridge**. Do not attempt to call `invoke()` or any Tauri plugin. There is no workaround.

### Baseline CSP (no approvals)
```
default-src 'self'
script-src  'self' 'unsafe-inline'
style-src   'self' 'unsafe-inline'
img-src     'self' data: blob:
font-src    'self' data:
connect-src 'none'            ← all fetch/XHR/WebSocket blocked
media-src   'none'
worker-src  'none'
frame-src   'none'
object-src  'none'
base-uri    'self'
```

`connect-src 'none'` means **all network I/O is blocked by default** — no `fetch()`, no `XMLHttpRequest`, no `WebSocket`, no `EventSource`.

---

## Capability Approval System

The static scanner detects capability signals and presents them to the user before the tool runs. The user approves or denies each one. Approvals take effect on the next `open_tool_window` call.

### Scanned Signals → Capabilities

| Pattern in source | Capability |
|---|---|
| `getUserMedia` | Camera + Microphone |
| `navigator.usb` | USB |
| `navigator.serial` | Serial |
| `navigator.hid` | HID |
| `navigator.bluetooth` | Bluetooth |
| `navigator.geolocation` / `getCurrentPosition` / `watchPosition` | Geolocation |
| `new Notification` / `Notification.requestPermission` | Notifications |
| `localStorage` / `sessionStorage` / `indexedDB` / `caches.open` | Storage |
| `fetch(` / `XMLHttpRequest` / `new WebSocket` / `new EventSource` | Network |

For network, Sanctum also extracts literal `https://` URLs from source and lists the hostnames. If no literal hosts are found, it marks the network capability as `(dynamic)`.

### What Approval Unlocks

| Approved capability | CSP relaxation |
|---|---|
| Network (specific hosts) | `connect-src`, `style-src`, `font-src`, `img-src` expand to include `https://{host}` and `wss://{host}` |
| Camera / Microphone | `media-src` expands to `'self' blob: mediastream:` |
| Storage | No CSP change needed — same-origin storage always available |
| Geolocation, Notifications, USB, Serial, HID, Bluetooth | CSP unchanged — these are browser permission APIs, not fetch-type directives |

### Scanner Limitations

The scan is **heuristic, not exhaustive**. It cannot detect:
- Capabilities hidden behind dynamic string construction: `fetch("ht"+"tps://evil.com")`
- Obfuscated or minified code using indirect eval
- Code loaded via `eval()` or `new Function()`
- CDN-hosted scripts that request capabilities

**The CSP is the real security boundary. The scanner is advisory.**

---

## Network Access

Tools that need to contact external services must:
1. Use literal `https://hostname` URLs in source code so the scanner can extract the host.
2. Have those hosts approved by the user.
3. Use `fetch()`, `XMLHttpRequest`, `WebSocket`, or `EventSource` — all work once `connect-src` is relaxed.

Dynamic network (runtime-constructed URLs) is detectable by the scanner as `(dynamic)` but the user must still approve it. The CSP cannot enforce per-host allowlisting for dynamic URLs; if the user approves dynamic network, `connect-src` is set permissively.

---

## Storage

All Web Storage APIs work within the tool's origin with no special approval needed:
- `localStorage` — persistent, survives app restart
- `sessionStorage` — tab-scoped, cleared on window close
- `indexedDB` — persistent, survives app restart
- `Cache API` (`caches.open`) — persistent

**Warning:** Storage is tied to the tool's UUID. If the tool is deleted and re-ingested, all stored data is unreachable.

---

## APIs That Work Without Approval

These browser APIs function normally in Sanctum tools without any capability approval:

| API | Notes |
|---|---|
| Canvas 2D / WebGL | Fully available |
| Web Audio API | Fully available |
| Web Workers | Blocked by `worker-src 'none'` in baseline CSP — needs network approval to relax |
| Web Crypto (`crypto.subtle`) | Fully available — secure context satisfied by custom protocol |
| `crypto.randomUUID()` | Available |
| `requestAnimationFrame` | Available |
| `ResizeObserver`, `IntersectionObserver` | Available |
| `navigator.clipboard` (read/write) | Available — OS may prompt the user |
| Drag and drop | Available |
| File API (`<input type="file">`) | Available |
| `TextEncoder` / `TextDecoder` | Available |
| `structuredClone`, `JSON` | Available |
| `setTimeout` / `setInterval` | Available |

---

## WebAuthn / Passkeys

WebAuthn (`navigator.credentials.create()` / `.get()`) **works in Sanctum tools** with important caveats.

**Why it works:**
- WKWebView (macOS) treats `sanctum-tool://` as a secure context — the primary WebAuthn requirement.
- `navigator.credentials` is not a network fetch; CSP `connect-src` does not block it.
- Platform authenticators (Touch ID, security keys) are handled by the OS layer, which Sanctum does not intercept in v0.

**Critical: the `rpId` must match the tool's host.** The tool cannot know its UUID at development time, so the `rpId` must be set dynamically:

```js
// Correct — derives rpId from the actual running origin
const rpId = window.location.hostname; // "tool-{uuid}"

const credential = await navigator.credentials.create({
  publicKey: {
    rp: { id: rpId, name: "My Tool" },
    // ... rest of options
  }
});
```

**Hardcoding `rpId` to a domain name will fail.** There is no DNS or HTTPS origin here.

**Origin stability caveat:** Credentials are permanently bound to `sanctum-tool://tool-{uuid}/`. If the user deletes and re-adds the tool, the UUID changes, the origin changes, and all previously registered credentials become inaccessible. Design your credential storage accordingly — consider exporting/importing credential metadata alongside the tool, or making re-enrollment frictionless.

**Scanner gap:** `navigator.credentials` is not currently detected by the capability scanner. A tool using WebAuthn will not show a Passkeys capability badge. This has no runtime impact — WebAuthn works regardless — but users will not see it in the permission manifest.

---

## What Does Not Work

| Feature | Status | Reason |
|---|---|---|
| `window.__TAURI__` | Blocked | Nuked by initialization script |
| Tauri `invoke()` | Blocked | IPC globals removed |
| `eval()` / `new Function(src)` | Works but undetectable by scanner | Not a recommended pattern |
| `<iframe>` embedding other origins | Blocked | `frame-src 'none'` |
| `<embed>` / `<object>` | Blocked | `object-src 'none'` |
| Service Workers | Blocked | `worker-src 'none'` in baseline |
| Shared Workers | Blocked | `worker-src 'none'` in baseline |
| Cross-tool `postMessage` | Blocked | Different origins, no shared BroadcastChannel |
| Loading scripts from CDN | Blocked unless CDN host is approved | `script-src 'self' 'unsafe-inline'` only |
| `navigator.sendBeacon` | Blocked | Respects `connect-src` |

---

## Practical Patterns

### Self-contained tool (no network)
Write everything inline. Use `<style>` and `<script>` tags directly in the HTML. All storage APIs and crypto work. The scanner will detect nothing, and the user will see "sandboxed — no network, no device access."

### Tool with external API
Include the API base URL as a literal in the source:
```js
const BASE = "https://api.example.com";
fetch(`${BASE}/endpoint`); // scanner extracts api.example.com
```
The user will be prompted to approve `api.example.com`.

### Tool using WebAuthn
```js
const rpId = window.location.hostname; // dynamic — don't hardcode
```
Inform users that uninstalling and reinstalling the tool will require re-enrollment.

### Tool with assets (CSS, images, fonts)
Bundle everything inline as base64 data URIs, or inline the CSS/JS directly in the HTML. External asset URLs must be in the approved host list to load.

---

## Version and Integrity

Each version of a tool is content-addressed by its SHA-256 hash. On every `open_tool_window` call, Sanctum re-hashes the stored file and compares it to the stored version ID. Any mismatch quarantines the tool permanently — it will not run until manually cleared.

Do not rely on being able to modify tool files on disk between runs. Sanctum will detect the change.

---

## Summary Table

| Capability | Default | After approval |
|---|---|---|
| Render HTML/CSS/JS | ✓ Always | — |
| Web Crypto | ✓ Always | — |
| Local storage (all types) | ✓ Always | — |
| File input (`<input>`) | ✓ Always | — |
| Canvas / WebGL / Audio | ✓ Always | — |
| WebAuthn / Passkeys | ✓ Always (with rpId caveat) | — |
| Network (`fetch`, XHR, WS) | ✗ Blocked | ✓ Per-host CSP relaxation |
| Camera / Microphone | ✗ Blocked by CSP + OS | ✓ media-src relaxed + OS prompt |
| Geolocation | ✗ Blocked by OS | ✓ OS prompt only |
| Notifications | ✗ Blocked by OS | ✓ OS prompt only |
| USB / Serial / HID / BT | ✗ Blocked by OS | ✓ OS prompt (v1: device_broker) |
| Tauri IPC | ✗ Permanently blocked | ✗ Not available |
| Framing / Workers | ✗ Blocked by CSP | ✗ Not available in v0 |
