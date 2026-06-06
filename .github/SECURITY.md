# Security Policy

**Do not open a public GitHub issue for security vulnerabilities.**

## Reporting

Email: **ultra@enigma.sh**  
Subject: `[SANCTUM SECURITY] <short description>`

Include: description, steps to reproduce, affected version, potential impact.

**Response commitments**
- Acknowledgement: within 48 hours
- Resolution timeline: within 7 days of acknowledgement
- Coordinated disclosure: please allow time to patch before publishing

## Scope

**In scope**
- Sandbox escape: tool window accessing the host OS
- IPC bypass: tool reaching the Tauri bridge despite the initialization script
- Path traversal in the `sanctum-tool://` protocol handler
- Integrity check bypass: running a quarantined or tampered tool
- CSP injection or bypass via crafted tool HTML
- Origin isolation failure: one tool reading another tool's storage

**Out of scope**
- Vulnerabilities in tools run inside Sanctum (Sanctum does not vouch for tool content)
- Denial of service against the local app
- Social engineering / phishing by a tool (by design, tools can render any HTML)

## Disclosure credit

Researchers are credited by name in release notes unless anonymity is requested.
