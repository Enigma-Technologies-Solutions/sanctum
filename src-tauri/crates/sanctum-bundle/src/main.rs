// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! `sanctum-bundle`: create keys, issue publisher certificates, sign and inspect bundles.
//!
//! Private keys are written only to the path you give, with mode 0600, and never overwrite
//! an existing file. Nothing here talks to a network.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use sanctum_bundle::*;
use std::collections::HashMap;
use std::io::Write;
use std::process::ExitCode;

const USAGE: &str = "\
sanctum-bundle keygen  --out KEYFILE
sanctum-bundle cert    --issuer KEYFILE --subject KEYID --name NAME --not-after UNIX
                       --scope APP_ID_PREFIX [--scope ...] [--not-before UNIX] --out CERTFILE
sanctum-bundle sign    --key KEYFILE --html FILE --app-id ID --name NAME --version X.Y.Z
                       --declared JSONFILE [--cert CERTFILE] [--issued-at UNIX] --out FILE.sanctum
sanctum-bundle inspect FILE.sanctum
sanctum-bundle verify  FILE.sanctum [--anchor KEYID=NAME ...] [--now UNIX]

KEYID looks like ed25519:<base64url>. --declared is a JSON array of capabilities in the
shape the app's scanner produces, e.g. [\"storage\", {\"smartcard\":[\"a0000005272101\"]}].";

struct Args {
    pos: Vec<String>,
    opts: HashMap<String, Vec<String>>,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut pos = Vec::new();
    let mut opts: HashMap<String, Vec<String>> = HashMap::new();
    let mut it = raw.iter();
    while let Some(a) = it.next() {
        if let Some(name) = a.strip_prefix("--") {
            let v = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
            opts.entry(name.to_string()).or_default().push(v.clone());
        } else {
            pos.push(a.clone());
        }
    }
    Ok(Args { pos, opts })
}

impl Args {
    fn one(&self, k: &str) -> Result<&str, String> {
        match self.opts.get(k).map(|v| v.as_slice()) {
            Some([v]) => Ok(v),
            Some(_) => Err(format!("--{k} given more than once")),
            None => Err(format!("missing --{k}")),
        }
    }
    fn opt(&self, k: &str) -> Result<Option<&str>, String> {
        if self.opts.contains_key(k) {
            self.one(k).map(Some)
        } else {
            Ok(None)
        }
    }
    fn many(&self, k: &str) -> Vec<String> {
        self.opts.get(k).cloned().unwrap_or_default()
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn int(s: &str, what: &str) -> Result<i64, String> {
    s.parse().map_err(|_| format!("{what} must be an integer"))
}

fn write_new(path: &str, bytes: &[u8], secret: bool) -> Result<(), String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let _ = secret;
    let mut f = opts
        .open(path)
        .map_err(|e| format!("cannot create {path}: {e} (existing files are never overwritten)"))?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

fn load_key(path: &str) -> Result<SigningKey, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let seed = v["secret"].as_str().ok_or("key file has no \"secret\"")?;
    let bytes = B64.decode(seed).map_err(|_| "secret is not base64url")?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| "secret is not 32 bytes")?;
    Ok(SigningKey::from_bytes(&arr))
}

fn run(argv: Vec<String>) -> Result<(), String> {
    let (cmd, rest) = argv.split_first().ok_or("no command")?;
    let a = parse_args(rest)?;
    match cmd.as_str() {
        "keygen" => {
            let key = SigningKey::generate(&mut OsRng);
            let id = key_id(&key.verifying_key());
            let body = serde_json::json!({
                "secret": B64.encode(key.to_bytes()),
                "keyid": id,
            });
            write_new(
                a.one("out")?,
                serde_json::to_string_pretty(&body).unwrap().as_bytes(),
                true,
            )?;
            println!("{id}");
            eprintln!(
                "Secret written to {}. Back it up offline; it cannot be recovered.",
                a.one("out")?
            );
            Ok(())
        }
        "cert" => {
            let issuer = load_key(a.one("issuer")?)?;
            let cert = Certificate {
                schema: STATEMENT_SCHEMA,
                subject: a.one("subject")?.to_string(),
                name: a.one("name")?.to_string(),
                not_before: match a.opt("not-before")? {
                    Some(v) => int(v, "--not-before")?,
                    None => now_unix(),
                },
                not_after: int(a.one("not-after")?, "--not-after")?,
                scope: a.many("scope"),
            };
            if cert.scope.is_empty() {
                return Err("give at least one --scope".into());
            }
            let blob = issue_certificate(&issuer, &cert)?;
            write_new(
                a.one("out")?,
                serde_json::to_string_pretty(&blob).unwrap().as_bytes(),
                false,
            )?;
            println!("issued by {}", blob.keyid);
            Ok(())
        }
        "sign" => {
            let key = load_key(a.one("key")?)?;
            let html = std::fs::read_to_string(a.one("html")?).map_err(|e| e.to_string())?;
            let declared: Vec<serde_json::Value> = serde_json::from_str(
                &std::fs::read_to_string(a.one("declared")?).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("--declared: {e}"))?;
            let cert = match a.opt("cert")? {
                Some(p) => Some(
                    serde_json::from_str::<SignedBlob>(
                        &std::fs::read_to_string(p).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| format!("--cert: {e}"))?,
                ),
                None => None,
            };
            let bundle = sign_bundle(
                &html,
                StatementInput {
                    app_id: a.one("app-id")?.into(),
                    name: a.one("name")?.into(),
                    version: a.one("version")?.into(),
                    declared,
                    issued_at: match a.opt("issued-at")? {
                        Some(v) => int(v, "--issued-at")?,
                        None => now_unix(),
                    },
                },
                &key,
                cert,
            )?;
            write_new(
                a.one("out")?,
                serde_json::to_string(&bundle).unwrap().as_bytes(),
                false,
            )?;
            println!("{}", checksum_of(&html));
            Ok(())
        }
        "inspect" | "verify" => {
            let path = a.pos.first().ok_or("give a bundle file")?;
            let bundle = parse_bundle(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let mut anchors = Vec::new();
            for spec in a.many("anchor") {
                let (id, name) = spec.split_once('=').ok_or("--anchor is KEYID=NAME")?;
                anchors.push(Anchor {
                    key: parse_key_id(id)?,
                    name: name.into(),
                });
            }
            let now = match a.opt("now")? {
                Some(v) => int(v, "--now")?,
                None => now_unix(),
            };
            match verify(&bundle, &anchors, now) {
                Ok(v) => {
                    println!("signature   valid");
                    println!("file hash   matches {}", v.statement.checksum);
                    println!("app id      {}", v.statement.app_id);
                    println!("name        {}", v.statement.name);
                    println!("version     {}", v.statement.version);
                    println!(
                        "declared    {}",
                        serde_json::to_string(&v.statement.declared).unwrap()
                    );
                    println!("signer      {}", v.signer_key);
                    match v.trust {
                        Trust::Anchored { publisher } => {
                            println!("trust       anchored: {publisher}")
                        }
                        Trust::Unanchored { reason } => println!(
                            "trust       unanchored{}",
                            reason.map(|r| format!(" ({r})")).unwrap_or_default()
                        ),
                    }
                    Ok(())
                }
                Err(e) if cmd == "inspect" => {
                    println!("NOT VALID: {e}");
                    Err("bundle does not verify".into())
                }
                Err(e) => Err(e.to_string()),
            }
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match run(argv) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            ExitCode::FAILURE
        }
    }
}
