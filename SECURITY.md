# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✓         |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: [ultra@enigma.sh](mailto:ultra@enigma.sh)  
Subject line: `[SANCTUM SECURITY] <short description>`

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Potential impact

You will receive an acknowledgement within **48 hours** and a resolution timeline within **7 days**.

We follow coordinated disclosure. Please allow us time to patch before publishing.

## Scope

In scope:
- Sandbox escape from a tool window to the host OS
- IPC bypass (tool accessing Tauri bridge despite initialization script)
- Path traversal in the `sanctum-tool://` protocol handler
- Integrity check bypass (running a quarantined or tampered tool)
- CSP injection or bypass via crafted tool HTML

Out of scope:
- Vulnerabilities in tools themselves (Sanctum does not vouch for tool content)
- Denial of service against the local app
- Social engineering

## Disclosure Credit

We credit researchers by name in release notes unless anonymity is requested.
