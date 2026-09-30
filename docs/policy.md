# Organisation policy: pinned checksums

For IT and security teams. Lets you say "only these reviewed tools may run" on a machine,
with no signing keys, no registry and no server. It is stage 2a of the plan in
[registry.md](registry.md).

## What it does

If the policy lists `pinned_checksums`, Sanctum opens a tool only when the SHA-256 of its
stored file is on the list. Everything else can still be added to the library, but will not
open, and the message says the organisation's policy is why.

- The hash checked is the one Sanctum just computed from the file it is about to serve,
  after the integrity check. A file swapped on disk cannot borrow another tool's hash.
- The policy only narrows what runs. It never grants a capability; users still approve
  each one.
- Sanctum re-reads the file every time a tool is opened, so a change applies without a
  restart. Windows that are already open are not closed.

## Where the file goes

| OS | Path |
|---|---|
| macOS | `/Library/Application Support/Sanctum/policy.json` |
| Linux | `/etc/sanctum/policy.json` |
| Windows | `%ProgramData%\Sanctum\policy.json` |

The path cannot be changed with an environment variable or a setting. A setting the user
controls would not be a policy.

On macOS and Linux the file must be owned by root and not writable by group or others
(`sudo chown root:wheel policy.json && sudo chmod 644 policy.json` on macOS; `root:root` on
Linux). Otherwise it is rejected, as described below. On Windows, protect the `Sanctum`
folder with an ACL that lets only administrators write. Sanctum does not inspect Windows
ACLs yet.

## Format

```json
{
  "schema_version": 1,
  "pinned_checksums": [
    "sha256:1175b0ac0a575996e035ff33543617585d63b2e544d8e493543ce6b3a37adb36"
  ]
}
```

| Field | Meaning |
|---|---|
| `schema_version` | Must be `1`. A higher number makes this Sanctum block tools and ask for an update. |
| `pinned_checksums` | Optional. `sha256:` plus 64 hex digits, any case. Leave it out to pin nothing. An empty list blocks every tool. |

Unknown fields are errors, not ignored. That way an older Sanctum never skips a control it
does not understand.

## Broken policy blocks tools

If the file exists but cannot be trusted, every tool is blocked and the library shows why.
Causes: not valid JSON, unknown field, wrong `schema_version`, a malformed hash, wrong owner
or permissions, a symbolic link, or a file over 1 MiB. No file at all means no policy, and
Sanctum behaves as it always has. Delete the file to lift enforcement.

## Getting the hash of a reviewed tool

In Sanctum, open the tool and read **Inspect, SHA-256**. Or from a copy of the file:

```bash
shasum -a 256 index.html          # macOS, Linux
certutil -hashfile index.html SHA256   # Windows
```

A new version of a tool is a different hash, so pinned tools do not update themselves: a
pin is a statement about exact bytes. For published tools you can also check where a file
came from with `gh attestation verify` (see registry.md, stage 0).

## Limits

- A user with administrator rights can change or remove the file. This is an organisation
  control, not protection against the machine's own administrator.
- It controls opening tools, not adding them.
- Managed by file only. MDM profile delivery, signed policies, capability ceilings and
  registry allow-lists come with stage 2b.
