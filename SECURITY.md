# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

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
- With Build apps with Codex turned on: the Codex process reading or writing outside its private
  work folder, a draft being added to the library without a click, or a saved file landing outside
  the Downloads folder or overwriting an existing file

Out of scope:
- What OpenAI does with the messages and drafts that Codex sends it when Build apps with Codex is on
- Vulnerabilities in tools themselves (Sanctum does not vouch for tool content)
- Denial of service against the local app
- Social engineering

## Disclosure Credit

We credit researchers by name in release notes unless anonymity is requested.
