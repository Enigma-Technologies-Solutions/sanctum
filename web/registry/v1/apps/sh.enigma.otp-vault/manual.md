## What it does

OTP Vault generates the six-digit codes that sites ask for as a second step when you sign in. You add the key a site gives you, and the vault shows the current code for it.

## What it asks Sanctum for

- **Storage.** The encrypted vault lives in this tool's own storage. Deleting the tool and adding it again gives it new, empty storage, so make a backup first.
- **Smart card, OATH applet (a0000005272101).** Optional. It is only used if you keep keys on a YubiKey.

It asks for no network access and no other device. You approve each of these yourself the first time you open the tool.

## Create a vault

Choose a username and a password, then press **Create vault**. The vault is encrypted with a key made from both. The tool also shows a fingerprint of eight emoji. Note it down: next time you unlock, the same username and password show the same eight emoji, and anything else means you mistyped.

There is no password reset. If you forget the password, the vault cannot be opened.

## Add a key

Choose **New authenticator key**. Paste the `otpauth://` link a site gives you, or enter the secret and the account by hand. The code appears next to the account name and refreshes on its own. Click a code to copy it.

## Use a YubiKey

If you approved smart card access for the OATH applet, you can write a key to your YubiKey instead of the vault. The secret goes to the key once and cannot be read back. Each code is computed on the key. Nothing about these accounts is stored in the tool's storage. If an account needs a touch, the key blinks when you ask for its code.

## Back up and restore

Tool windows cannot save files, so **Copy backup** puts the encrypted backup on the clipboard. Paste it into a safe place. **Restore pasted backup** accepts pasted text, and **Choose file** accepts a file. A backup is still encrypted, so it is only as safe as your password.

## Good to know

- Codes from the vault are computed in the tool window. They do not leave it unless you click one to copy it.
- Keys held on a YubiKey are not in the backup.
