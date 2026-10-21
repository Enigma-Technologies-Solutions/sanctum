#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
"""Pin a Codex release for Sanctum to download on first use.

    scripts/pin-codex.py 0.163.0

Downloads the release archive for each platform Sanctum ships on, checks it against the
digest GitHub publishes for the asset, takes out the one program inside, and writes
src-tauri/src/agent/codex-pins.json with the sizes and SHA-256 of both the archive and the
program. Sanctum refuses anything that does not match. Review the diff before committing.

Run it on a machine you trust: whatever it downloads now is what every user gets later.
"""
import hashlib, io, json, subprocess, sys, tarfile, urllib.request
from pathlib import Path

REPO = "openai/codex"
# Sanctum key (os-arch) -> (release asset, name of the program inside the archive)
TARGETS = {
    "macos-aarch64": ("codex-aarch64-apple-darwin.tar.gz", "codex-aarch64-apple-darwin", "codex"),
    "macos-x86_64": ("codex-x86_64-apple-darwin.tar.gz", "codex-x86_64-apple-darwin", "codex"),
    "linux-aarch64": ("codex-aarch64-unknown-linux-musl.tar.gz", "codex-aarch64-unknown-linux-musl", "codex"),
    "linux-x86_64": ("codex-x86_64-unknown-linux-musl.tar.gz", "codex-x86_64-unknown-linux-musl", "codex"),
    "windows-x86_64": ("codex-x86_64-pc-windows-msvc.exe.tar.gz", "codex-x86_64-pc-windows-msvc.exe", "codex.exe"),
}
OUT = Path(__file__).resolve().parent.parent / "src-tauri/src/agent/codex-pins.json"


def gh_digests(tag):
    out = subprocess.run(
        ["gh", "api", f"repos/{REPO}/releases/tags/{tag}", "--jq",
         ".assets[] | [.name, (.digest // \"\")] | @tsv"],
        check=True, capture_output=True, text=True).stdout
    return dict(line.split("\t") for line in out.splitlines())


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    version = sys.argv[1]
    tag = f"rust-v{version}"
    digests = gh_digests(tag)
    pins = {}
    for key, (asset, entry, file) in TARGETS.items():
        url = f"https://github.com/{REPO}/releases/download/{tag}/{asset}"
        print(f"{key}: downloading {asset}", file=sys.stderr)
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
        pins[key] = {
            "url": url,
            "archiveSha256": sha,
            "archiveSize": len(data),
            "entry": entry,
            "file": file,
            "sha256": hashlib.sha256(blob).hexdigest(),
            "size": len(blob),
            "githubDigest": bool(published),
        }
    OUT.write_text(json.dumps({"version": version, "pins": pins}, indent=2) + "\n")
    print(f"wrote {OUT}", file=sys.stderr)


main()
