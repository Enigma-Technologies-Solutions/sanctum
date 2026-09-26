# OTP Vault (example tool)

A two-factor code generator (TOTP, RFC 6238) written as a single HTML file for Sanctum.
It is also the reference example for [SANCTUM_FOR_AGENTS.md](../../SANCTUM_FOR_AGENTS.md):
it uses origin-scoped storage, Web Crypto and the smart card bridge, and asks for nothing else.

## What it asks Sanctum for

| Capability | Why |
|---|---|
| Storage | The encrypted vault lives in this tool's own `localStorage` origin. |
| Smart card: OATH (TOTP/HOTP) `a0000005272101` | Optional. Keeps secrets on a YubiKey and lets the key compute the codes. |

No network host is requested. `scan.rs` pins this in the test
`otp_vault_example_asks_for_storage_and_oath_only`, so a change that widens the approval
screen fails CI.

## How it works

**Software vault.** Username and password go through PBKDF2-SHA-256 (600,000 iterations,
salt bound to the username), then HKDF-SHA-256 into two outputs: an AES-256-GCM key
(non-extractable) and a separate fingerprint value. The fingerprint is shown as eight
emoji, one per byte from a fixed 256-entry table, so the user can recognise a correct
username and password before anything is decrypted. Each vault is one encrypted record,
authenticated with the vault id as associated data.

**YubiKey mode.** With smart card access approved for the OATH applet, a key can be
written to the YubiKey instead of the vault. The secret is sent once in a `PUT` and cannot
be read back; each code comes from a `CALCULATE` on the key. Nothing about these accounts
is written to the tool's storage. APDU encoding follows `yubikit/oath.py` and was checked
byte for byte against it for `PUT`, `CALCULATE`, `DELETE` and `VALIDATE`, including key
shortening for long secrets and non-default periods.

## Behaviour inside Sanctum

- **Storage follows the tool id.** A new version of the tool keeps the vault. Deleting the
  tool and adding it again gives it a new origin and empty storage.
- **Backups use the clipboard.** Tool windows refuse navigation off their own origin,
  `blob:` included, so `<a download>` cannot save a file. "Copy backup" puts the encrypted
  JSON on the clipboard; "Restore" accepts pasted text or a chosen file. See #5.
- **Codes on request for YubiKey accounts.** `CALCULATE ALL` is `00 A4 00 01`. The broker
  refuses interindustry INS `A4` as SELECT whatever the selected applet, so the tool falls
  back to `LIST` and computes each code when clicked. A touch-protected account blinks the
  key at that point. See #3.
- **Long OATH answers.** The OATH applet continues long responses with `SEND REMAINING`
  (`A5`) and answers `GET RESPONSE` (`C0`) with `6D00`. The broker drives chaining with
  `C0`, so a key whose account list does not fit in one response cannot be listed. See #4.

Other gaps found while building this tool: storage is lost on delete and re-add (#6), a
tool cannot read its own checksum or approvals (#7), there is no CLI for scanning and
provisioning (#8), and no way yet to pin or sign reviewed tools (#9).

## Testing

Tested outside Sanctum with Chrome (Playwright):

- Core: RFC 6238 vectors for SHA-1, SHA-256 and SHA-512; base32; `otpauth://` parsing;
  key derivation determinism; AES-GCM round trip and tamper rejection.
- UI: create, fingerprint check, add keys, lock, wrong-password rejection, unlock,
  password change, delete, clipboard backup and restore.
- Smart card: Sanctum's own `SMARTCARD_BRIDGE` script from `runner.rs`, with
  `/__sanctum/v1/*` answered by an emulator of `smartcard.rs` rules over a real YubiKey 5C
  (firmware 5.7.4), read-only: select, the refused `CALCULATE ALL`, the `LIST` fallback,
  and a refused `select` of the OpenPGP applet.

Not yet tested inside a built Sanctum window, and the write path (`PUT`, `DELETE`) has
not been run against hardware.

## Provenance

`.github/workflows/examples.yml` records the SHA-256 of every example and, on `main`,
publishes a GitHub artifact attestation (Sigstore, SLSA build provenance) for it. To check
a copy before adding it to Sanctum:

```bash
shasum -a 256 index.html          # compare with Inspect → SHA-256 in Sanctum
gh attestation verify index.html --repo Enigma-Technologies-Solutions/sanctum
```

The wider plan for signed, registry-listed tools is in [docs/registry.md](../../docs/registry.md).
