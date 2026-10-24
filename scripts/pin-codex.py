#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
"""Pin a Codex release for Sanctum to download on first use.

    scripts/pin-codex.py 0.163.0

Downloads the release archives for each platform Sanctum ships on (the `codex` program and
the `codex-code-mode-host` helper it starts to run commands), checks each against the digest
GitHub publishes for the asset, takes out the one program inside each, and writes
src-tauri/src/agent/codex-pins.json with the sizes and SHA-256 of both the archive and the
program. Sanctum refuses anything that does not match. Review the diff before committing.

Run it on a machine you trust: whatever it downloads now is what every user gets later.
"""
import hashlib, io, json, subprocess, sys, tarfile, urllib.request
from pathlib import Path

REPO = "openai/codex"
# Sanctum key (os-arch) -> (target triple, file extension of the programs)
TARGETS = {
    "macos-aarch64": ("aarch64-apple-darwin", ""),
    "macos-x86_64": ("x86_64-apple-darwin", ""),
    "linux-aarch64": ("aarch64-unknown-linux-musl", ""),
    "linux-x86_64": ("x86_64-unknown-linux-musl", ""),
    "windows-x86_64": ("x86_64-pc-windows-msvc", ".exe"),
}
# Programs taken from each release: (asset prefix, name saved under, is the main program).
# Codex looks for the helper next to itself, under exactly this name.
PROGRAMS = [("codex", "codex", True), ("codex-code-mode-host", "codex-code-mode-host", False)]
OUT = Path(__file__).resolve().parent.parent / "src-tauri/src/agent/codex-pins.json"


def gh_digests(tag):
    out = subprocess.run(
        ["gh", "api", f"repos/{REPO}/releases/tags/{tag}", "--jq",
         ".assets[] | [.name, (.digest // \"\")] | @tsv"],
        check=True, capture_output=True, text=True).stdout
    return dict(line.split("\t") for line in out.splitlines())


def pin_asset(tag, digests, asset, entry, file):
    url = f"https://github.com/{REPO}/releases/download/{tag}/{asset}"
    print(f"downloading {asset}", file=sys.stderr)
    data = urllib.request.urlopen(url).read()
    sha = hashlib.sha256(data).hexdigest()
    published = digests.get(asset, "")
    if published and published != f"sha256:{sha}":
        sys.exit(f"{asset}: downloaded {sha} but GitHub lists {published}")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        names = tf.getnames()
        if entry not in names:
            sys.exit(f"{asset}: no {entry} inside (found {names})")
        member = tf.getmember(entry)
        if not member.isfile():
            sys.exit(f"{asset}: {entry} is not a plain file")
        blob = tf.extractfile(member).read()
    return {
        "url": url,
        "archiveSha256": sha,
        "archiveSize": len(data),
        "entry": entry,
        "file": file,
        "sha256": hashlib.sha256(blob).hexdigest(),
        "size": len(blob),
        "githubDigest": bool(published),
    }


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    version = sys.argv[1]
    tag = f"rust-v{version}"
    digests = gh_digests(tag)
    pins = {}
    for key, (triple, ext) in TARGETS.items():
        main_pin, helpers = None, []
        for prefix, name, is_main in PROGRAMS:
            entry = f"{prefix}-{triple}{ext}"
            pin = pin_asset(tag, digests, f"{entry}.tar.gz", entry, name + ext)
            if is_main:
                main_pin = pin
            else:
                helpers.append(pin)
        pins[key] = {**main_pin, "helpers": helpers}
    OUT.write_text(json.dumps({"version": version, "pins": pins}, indent=2) + "\n")
    print(f"wrote {OUT}", file=sys.stderr)


main()
