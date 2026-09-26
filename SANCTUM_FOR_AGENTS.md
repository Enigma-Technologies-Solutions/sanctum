# Writing HTML tools for Sanctum

Sanctum is a desktop app (macOS, Windows, Linux) that runs single-file HTML tools in a sandbox. This page is for anyone, human or model, writing a tool that should work inside it.

## How a tool is loaded

1. **Ingest.** The user pastes HTML from the clipboard or picks a file. Sanctum stores a copy and never runs the original.
2. **Scan.** Sanctum scans the raw HTML for capability signals (API names, URL literals). The scan only decides what the approval screen shows. It isn't what enforces the sandbox.
3. **Integrity.** The file's SHA-256 is its version ID. It's recomputed on every launch.
4. **Approval.** The user sees the detected capabilities and turns each one on or off.
5. **Run.** A new WebView window serves the tool from a custom protocol, with a Content Security Policy built from the approved capabilities.

## Origin

Every tool runs at its own origin:

```
sanctum-tool://tool-{uuid}/
```

The UUID is assigned at ingest and doesn't change for that tool. On Windows the WebView serves custom schemes over `http://sanctum-tool.localhost/` instead, so don't hardcode the scheme.

| Concern | Behavior |
|---|---|
| `localStorage`, `indexedDB` | Scoped to this origin. Persist across runs. |
| `sessionStorage` | Scoped to this origin. Cleared when the window closes. |
| `document.cookie` | Scoped to this origin. |
| Other tools | Different UUID, different origin, so no shared storage. |
| Delete and re-add | New UUID, new origin. Everything the old copy stored is unreachable. |

```js
const myOrigin = window.location.origin;   // "sanctum-tool://tool-{uuid}"
const myHost   = window.location.hostname; // "tool-{uuid}"
```

## Default restrictions

An initialization script removes these globals before any tool code runs:

```
window.__TAURI__, __TAURI_IPC__, __TAURI_INTERNALS__, __TAURI_INVOKE__, ipc, __TAURI_METADATA__
```

Tool windows also have an empty Tauri capability set. Don't try to call `invoke()` or a Tauri plugin; nothing will answer.

The CSP when nothing is approved:

```
default-src 'self'
script-src  'self' 'unsafe-inline'
style-src   'self' 'unsafe-inline'
img-src     'self' data: blob:
font-src    'self' data:
connect-src 'none'
media-src   'none'
worker-src  'none'
frame-src   'none'
object-src  'none'
form-action 'none'
base-uri    'self'
```

`connect-src 'none'` blocks `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon`. Top-level navigation away from the tool's own origin is also refused, so `location.href = "https://..."` doesn't work as a way out.

## What the scanner looks for

| Pattern in source | Capability |
|---|---|
| `getUserMedia` | Camera and microphone |
| `navigator.usb` | USB |
| `navigator.serial` | Serial |
| `navigator.hid` | HID |
| `navigator.bluetooth` | Bluetooth |
| `navigator.geolocation`, `getCurrentPosition`, `watchPosition` | Geolocation |
| `new Notification`, `Notification.requestPermission` | Notifications |
| `localStorage`, `sessionStorage`, `indexedDB`, `caches.open` | Storage |
| `fetch(`, `XMLHttpRequest`, `new WebSocket`, `new EventSource` | Network |
| `sanctum.smartcard` plus literal AIDs | Smart card, per applet |

For network access the scanner also collects the hostnames of literal `https://` URLs. If it finds network calls but no literal hosts, it records the host list as `(dynamic)`.

The scan is a set of regular expressions. It misses URLs built from pieces (`"ht" + "tps://..."`), code run through `eval()` or `new Function()`, minified or obfuscated code, and scripts loaded from a CDN. Missing something doesn't grant it: the CSP only contains what the user approved.

## What approval changes

| Approved capability | Effect on the CSP |
|---|---|
| Network, specific hosts | `connect-src`, `style-src`, `font-src` and `img-src` gain `https://{host}` and `wss://{host}` for each host |
| Network, `(dynamic)` only | Nothing. `(dynamic)` is a label on the approval screen and never becomes a CSP source. |
| Camera or microphone | `media-src` becomes `'self' blob: mediastream:`, and the OS asks the user as well |
| Storage | Nothing. Same-origin storage always works; this entry is there so the user knows. |
| Smart card | `connect-src` gains `'self' sanctum-tool:` so the tool can reach Sanctum's card bridge on its own origin, and `window.sanctum.smartcard` is injected. See the [README](README.md#smart-card-access). |
| Geolocation, notifications, USB, serial, HID, Bluetooth | Nothing yet. No CSP directive covers these, and Sanctum doesn't gate them itself, so the WebView and OS permission prompts decide whether or not the user approved them. |

Approvals apply the next time the tool's window is opened.

## Network access

A tool that calls an external service needs to:

1. Put the full `https://hostname` URL in the source as a literal, so the scanner finds the host.
2. Have the user approve that host.

```js
const BASE = "https://api.example.com";
fetch(`${BASE}/endpoint`); // the scanner picks up api.example.com
```

URLs built at run time from anything other than a literal host won't work, even if the user approves `(dynamic)`.

## APIs that work without approval

Canvas 2D, WebGL, Web Audio, Web Crypto (`crypto.subtle`, `crypto.randomUUID()`), `TextEncoder`/`TextDecoder`, `structuredClone`, `requestAnimationFrame`, `ResizeObserver`, `IntersectionObserver`, timers, drag and drop, `<input type="file">`, and `navigator.clipboard` (the OS may prompt). The custom protocol counts as a secure context, so APIs that require one are available.

## What doesn't work

| Feature | Why |
|---|---|
| `window.__TAURI__`, `invoke()` | Removed before the tool runs |
| Web Workers, Shared Workers, Service Workers | `worker-src 'none'`, whatever is approved |
| `<iframe>` | `frame-src 'none'` |
| `<embed>`, `<object>` | `object-src 'none'` |
| Form submission | `form-action 'none'` |
| Scripts from a CDN | `script-src` is `'self' 'unsafe-inline'` only. Inline the library. |
| `postMessage` or `BroadcastChannel` to another tool | Different origins |
| `eval()`, `new Function()` | Runs, but the scanner can't see what it does |

## WebAuthn and passkeys

`navigator.credentials.create()` and `.get()` work on macOS, where WKWebView treats `sanctum-tool://` as a secure context. They aren't network fetches, so `connect-src` doesn't affect them. Other platforms haven't been checked yet.

The `rpId` has to match the tool's host, which the tool can't know ahead of time. Read it at run time:

```js
const rpId = window.location.hostname; // "tool-{uuid}"

const credential = await navigator.credentials.create({
  publicKey: {
    rp: { id: rpId, name: "My Tool" },
    // ...
  },
});
```

A hardcoded domain as `rpId` will fail. Credentials are bound to `tool-{uuid}`, so if the user deletes and re-adds the tool, old credentials can't be used. Tell users they'll need to enroll again in that case.

The scanner doesn't detect `navigator.credentials` yet, so WebAuthn use won't appear on the approval screen. It still works.

## Assets

Put CSS and JavaScript inline, and embed images and fonts as `data:` URIs. An external asset only loads if its host has been approved.

## Versions and integrity

Each version is stored under its SHA-256. Before opening a window Sanctum re-hashes the stored file. If it doesn't match, that version is quarantined and won't run again; the user has to add a clean copy. Don't expect to edit a stored tool on disk between runs.

## Quick reference

| Capability | By default | After approval |
|---|---|---|
| HTML, CSS, inline JS | Works | |
| Web Crypto | Works | |
| Storage (all kinds) | Works | |
| File input | Works | |
| Canvas, WebGL, Web Audio | Works | |
| WebAuthn | Works on macOS (see `rpId`) | |
| Network | Blocked | Allowed for approved hosts |
| Camera, microphone | Blocked | Allowed, plus OS prompt |
| Geolocation, notifications | OS prompt decides | OS prompt decides |
| USB, serial, HID, Bluetooth | OS prompt decides | OS prompt decides |
| Smart card | Not available | Approved applets only |
| Tauri IPC | Not available | Not available |
| Frames, workers | Blocked | Blocked |

A tool with nothing approved shows "sandboxed, no network or device access" in its window title.
