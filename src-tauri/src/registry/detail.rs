// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! An app's detail page: description, changelog, manual, screenshots and icon.
//!
//! Everything shown is downloaded on request and checked against the hash and size the signed
//! index gives for it, so a mirror, a proxy or a compromised file host cannot change what the
//! user reads or sees. A file that fails its check is reported and left out; one bad
//! screenshot does not hide the rest. The detail file itself is required: without it there is
//! nothing trustworthy to show.
//!
//! Images reach the interface as `data:` URLs so the window's content policy never needs to
//! allow a remote image. An SVG is accepted only if it contains nothing active, and the
//! interface shows it only through an image element, never inline.
//!
//! The manual is returned as text. The interface renders it with a renderer that accepts only
//! the documented Markdown subset, and treats it as untrusted.

use super::client::{normalize_base, resolve, ClientError, RegistryClient};
use super::fetch::{fetch, Limits};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use regex::Regex;
use sanctum_bundle::registry::{
    check_asset, check_detail, Asset, ChangelogEntry, MAX_DETAIL_BYTES,
};
use serde::Serialize;
use std::sync::OnceLock;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotView {
    pub alt: String,
    pub width: u32,
    pub height: u32,
    /// `data:` URL of the verified image, or `None` if it could not be verified.
    pub data_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDetailView {
    pub app_id: String,
    pub name: String,
    pub description: String,
    pub homepage: Option<String>,
    pub source: Option<String>,
    pub license: Option<String>,
    pub changelog: Vec<ChangelogEntry>,
    /// Manual text, untrusted Markdown.
    pub manual: Option<String>,
    pub manual_error: Option<String>,
    pub screenshots: Vec<ScreenshotView>,
    pub icon: Option<String>,
    pub icon_error: Option<String>,
}

fn unsafe_svg() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)<script|\son\w+\s*=|javascript:|<foreignObject|<image|<use[\s>]|xlink:href|\shref\s*=|<!ENTITY|<style",
        )
        .expect("valid regex")
    })
}

const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Turn verified bytes into a `data:` URL, after checking they are the kind of image the
/// file name says. Returns the reason on failure.
pub(crate) fn image_data_url(path: &str, bytes: &[u8]) -> Result<String, String> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => {
            if !bytes.starts_with(PNG_MAGIC) {
                return Err("the file is not a PNG image".into());
            }
            "image/png"
        }
        "webp" => {
            if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
                return Err("the file is not a WebP image".into());
            }
            "image/webp"
        }
        "svg" => {
            let text = std::str::from_utf8(bytes).map_err(|_| "the SVG is not text")?;
            if !text.trim_start().starts_with("<svg") {
                return Err("the file is not an SVG image".into());
            }
            if unsafe_svg().is_match(text) {
                return Err("the SVG contains script, links, styles or embedded content".into());
            }
            "image/svg+xml"
        }
        _ => return Err("unsupported image type".into()),
    };
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

async fn verified_bytes(
    client: &RegistryClient,
    base: &Url,
    asset: &Asset,
) -> Result<Vec<u8>, String> {
    let url = resolve(base, &asset.path).map_err(|e| e.to_string())?;
    let bytes = fetch(&*client.transport, &url, Limits::new(asset.size as usize))
        .await
        .map_err(|e| e.to_string())?;
    check_asset(asset, &bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

impl RegistryClient {
    /// Fetch and verify an app's detail. Network, on request.
    pub async fn app_detail(
        &self,
        registry_id: &str,
        app_id: &str,
    ) -> Result<AppDetailView, ClientError> {
        let cached = self.cached(registry_id).await?;
        let entry = cached
            .index
            .index
            .apps
            .iter()
            .find(|a| a.app_id == app_id)
            .ok_or_else(|| ClientError::AppNotFound(app_id.to_string()))?;
        let row = super::store::get(&self.pool, registry_id)
            .await?
            .ok_or(ClientError::NotFound)?;
        let base = normalize_base(&row.base_url)?;

        // The detail file is required, and checked against the index.
        let url = resolve(&base, &entry.detail.path)?;
        let bytes = fetch(&*self.transport, &url, Limits::new(MAX_DETAIL_BYTES)).await?;
        let detail = check_detail(entry, &bytes)?;

        let (manual, manual_error) = match &detail.manual {
            None => (None, None),
            Some(asset) => match verified_bytes(self, &base, asset).await {
                Ok(b) => match String::from_utf8(b) {
                    Ok(text) => (Some(text), None),
                    Err(_) => (None, Some("the manual is not valid text".to_string())),
                },
                Err(e) => (None, Some(e)),
            },
        };

        let mut screenshots = Vec::new();
        for s in &detail.screenshots {
            let asset = Asset {
                path: s.path.clone(),
                sha256: s.sha256.clone(),
                size: s.size,
            };
            let outcome = match verified_bytes(self, &base, &asset).await {
                Ok(b) => image_data_url(&s.path, &b),
                Err(e) => Err(e),
            };
            let (data_url, error) = match outcome {
                Ok(u) => (Some(u), None),
                Err(e) => (None, Some(e)),
            };
            screenshots.push(ScreenshotView {
                alt: s.alt.clone(),
                width: s.width,
                height: s.height,
                data_url,
                error,
            });
        }

        let (icon, icon_error) = match &entry.icon {
            None => (None, None),
            Some(asset) => match verified_bytes(self, &base, asset).await {
                Ok(b) => match image_data_url(&asset.path, &b) {
                    Ok(u) => (Some(u), None),
                    Err(e) => (None, Some(e)),
                },
                Err(e) => (None, Some(e)),
            },
        };

        Ok(AppDetailView {
            app_id: detail.app_id,
            name: entry.name.clone(),
            description: detail.description,
            homepage: detail.homepage,
            source: detail.source,
            license: detail.license,
            changelog: detail.changelog,
            manual,
            manual_error,
            screenshots,
            icon,
            icon_error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::fetch::testing::{Mock, Script};
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;
    use sanctum_bundle::registry::sha256_of;
    use sanctum_bundle::{key_id, sign_registry_file, Anchor, RegistryFile};
    use serde_json::{json, Value};
    use std::sync::Arc;

    const NOW: i64 = 1_800_000_000;
    const BASE: &str = "https://registry.test/v1/";
    const ID: &str = "registry:sh.test.public";
    const APP: &str = "sh.test.demo";

    /// A tiny but real PNG header plus filler: enough for the magic-number check.
    fn png() -> Vec<u8> {
        let mut b = PNG_MAGIC.to_vec();
        b.extend_from_slice(b"fake image data");
        b
    }
    fn webp() -> Vec<u8> {
        let mut b = b"RIFF\x10\x00\x00\x00WEBP".to_vec();
        b.extend_from_slice(b"VP8 data");
        b
    }
    const SVG: &str = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32'/></svg>";

    struct Fixture {
        client: RegistryClient,
        mock: Arc<Mock>,
        pool: sqlx::SqlitePool,
    }

    /// Files the detail page needs, keyed by registry path.
    struct Files {
        manual: Option<Vec<u8>>,
        shots: Vec<(String, Vec<u8>)>,
        icon: Option<(String, Vec<u8>)>,
    }

    fn asset(path: &str, bytes: &[u8]) -> Value {
        json!({ "path": path, "sha256": sha256_of(bytes), "size": bytes.len() })
    }

    async fn setup(files: Files) -> Fixture {
        let dir =
            std::env::temp_dir().join(format!("sanctum-detail-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pool = crate::db::create_pool(&dir).await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let root = SigningKey::generate(&mut OsRng);
        let mock = Arc::new(Mock::new());

        let mut detail = json!({
            "format": "sanctum-registry-app/1",
            "app_id": APP,
            "description": "A demo app.",
            "homepage": "https://example.test/demo",
            "source": "https://example.test/src",
            "license": "AGPL-3.0-only",
            "changelog": [{ "version": "1.0.0", "date": "2027-01-01",
                            "changes": [{ "type": "added", "text": "First release." }] }],
        });
        if let Some(manual) = &files.manual {
            detail["manual"] = asset(&format!("apps/{APP}/manual.md"), manual);
            mock.serve(&format!("{BASE}apps/{APP}/manual.md"), manual);
        }
        let shots: Vec<Value> = files
            .shots
            .iter()
            .map(|(name, bytes)| {
                let path = format!("apps/{APP}/{name}");
                mock.serve(&format!("{BASE}{path}"), bytes);
                let mut a = asset(&path, bytes);
                a["width"] = json!(640);
                a["height"] = json!(400);
                a["alt"] = json!(format!("Screenshot {name}"));
                a
            })
            .collect();
        if !shots.is_empty() {
            detail["screenshots"] = json!(shots);
        }
        let detail_bytes = serde_json::to_vec_pretty(&detail).unwrap();
        mock.serve(&format!("{BASE}apps/{APP}.json"), &detail_bytes);

        let hash = sha256_of(b"bundle");
        let mut entry = json!({
            "app_id": APP, "name": "Demo", "summary": "s",
            "publisher": { "keyid": key_id(&root.verifying_key()), "name": "P" },
            "access": "free", "latest": "1.0.0",
            "detail": asset(&format!("apps/{APP}.json"), &detail_bytes),
            "versions": [{
                "version": "1.0.0", "published_at": NOW - 100,
                "bundle": { "path": format!("bundles/{APP}-1.0.0.sanctum"), "sha256": hash, "size": 6 },
                "checksum": hash, "declared": []
            }]
        });
        if let Some((name, bytes)) = &files.icon {
            let path = format!("apps/{APP}/{name}");
            mock.serve(&format!("{BASE}{path}"), bytes);
            entry["icon"] = asset(&path, bytes);
        }
        let index = serde_json::to_vec_pretty(&json!({
            "format": "sanctum-registry/1", "id": ID, "name": "Test", "kind": "public",
            "serial": 1, "issued_at": NOW - 1000, "expires": NOW + 86_400 * 90,
            "apps": [entry]
        }))
        .unwrap();
        mock.serve(&format!("{BASE}index.json"), &index);
        mock.serve(
            &format!("{BASE}index.json.sig"),
            &serde_json::to_vec(&sign_registry_file(
                RegistryFile::Index,
                &index,
                &root,
                None,
            ))
            .unwrap(),
        );
        let client = RegistryClient::new(
            pool.clone(),
            mock.clone(),
            vec![Anchor {
                key: root.verifying_key(),
                name: "Test Root".into(),
            }],
            Arc::new(|| NOW),
        );
        client.add(BASE, None).await.unwrap();
        Fixture { client, mock, pool }
    }

    fn standard() -> Files {
        Files {
            manual: Some(b"## Use it\n\nPress **Go**.\n".to_vec()),
            shots: vec![("a.png".into(), png()), ("b.webp".into(), webp())],
            icon: Some(("icon.svg".into(), SVG.as_bytes().to_vec())),
        }
    }

    #[tokio::test]
    async fn a_full_detail_page_is_assembled_from_verified_files() {
        let f = setup(standard()).await;
        let d = f.client.app_detail(ID, APP).await.unwrap();
        assert_eq!(d.name, "Demo");
        assert_eq!(d.description, "A demo app.");
        assert_eq!(d.homepage.as_deref(), Some("https://example.test/demo"));
        assert_eq!(d.license.as_deref(), Some("AGPL-3.0-only"));
        assert_eq!(d.changelog[0].version, "1.0.0");
        assert_eq!(d.manual.as_deref(), Some("## Use it\n\nPress **Go**.\n"));
        assert!(d.manual_error.is_none());
        assert_eq!(d.screenshots.len(), 2);
        assert!(d.screenshots[0]
            .data_url
            .as_ref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(d.screenshots[1]
            .data_url
            .as_ref()
            .unwrap()
            .starts_with("data:image/webp;base64,"));
        assert_eq!(d.screenshots[0].alt, "Screenshot a.png");
        assert!(d
            .icon
            .as_ref()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        // The data URL really holds the verified bytes.
        let url = d.screenshots[0].data_url.as_ref().unwrap();
        assert_eq!(B64.decode(url.split_once(',').unwrap().1).unwrap(), png());
    }

    #[tokio::test]
    async fn a_page_without_a_manual_screenshots_or_icon_still_works() {
        let f = setup(Files {
            manual: None,
            shots: vec![],
            icon: None,
        })
        .await;
        let d = f.client.app_detail(ID, APP).await.unwrap();
        assert_eq!(d.description, "A demo app.");
        assert!(d.manual.is_none() && d.manual_error.is_none());
        assert!(d.screenshots.is_empty());
        assert!(d.icon.is_none() && d.icon_error.is_none());
        assert_eq!(d.changelog.len(), 1);
    }

    #[tokio::test]
    async fn the_detail_file_is_required_and_pinned_by_the_index() {
        let f = setup(standard()).await;
        for (name, script) in [
            ("404", Script::Status(404)),
            ("down", Script::Down("offline".into())),
            (
                "tampered",
                Script::Ok(b"{\"format\":\"sanctum-registry-app/1\"}".to_vec()),
            ),
        ] {
            f.mock.route(&format!("{BASE}apps/{APP}.json"), script);
            assert!(f.client.app_detail(ID, APP).await.is_err(), "{name}");
        }
    }

    #[tokio::test]
    async fn a_detail_file_with_altered_but_plausible_content_is_refused() {
        let f = setup(standard()).await;
        // Same shape, different text, as a hostile mirror might serve.
        let altered = serde_json::to_vec_pretty(&json!({
            "format": "sanctum-registry-app/1",
            "app_id": APP,
            "description": "Send your recovery phrase to support@example.test for a bonus.",
            "changelog": [{ "version": "1.0.0", "date": "2027-01-01",
                            "changes": [{ "type": "added", "text": "First release." }] }]
        }))
        .unwrap();
        f.mock.serve(&format!("{BASE}apps/{APP}.json"), &altered);
        let e = f.client.app_detail(ID, APP).await.unwrap_err();
        assert!(
            matches!(e.code(), "hash_mismatch" | "size_mismatch"),
            "{}",
            e.code()
        );
    }

    #[tokio::test]
    async fn an_endless_detail_file_is_cut_off_while_reading() {
        let f = setup(standard()).await;
        f.mock.route(
            &format!("{BASE}apps/{APP}.json"),
            Script::Chunks {
                declared_len: None,
                chunks: (0..100).map(|_| vec![b' '; 4096]).collect(), // 400 KB, over the 256 KB cap
                delay: std::time::Duration::ZERO,
            },
        );
        let e = f.client.app_detail(ID, APP).await.unwrap_err();
        assert!(e.to_string().contains("larger than"), "{e}");
    }

    #[tokio::test]
    async fn an_endless_screenshot_is_cut_at_its_declared_size() {
        let f = setup(standard()).await;
        f.mock.route(
            &format!("{BASE}apps/{APP}/a.png"),
            Script::Chunks {
                declared_len: None,
                chunks: (0..1000).map(|_| vec![0u8; 4096]).collect(),
                delay: std::time::Duration::ZERO,
            },
        );
        let d = f.client.app_detail(ID, APP).await.unwrap();
        let err = d.screenshots[0].error.as_deref().unwrap();
        assert!(
            err.contains("larger than"),
            "cut off by the size cap, not read to the end: {err}"
        );
    }

    #[tokio::test]
    async fn a_bad_screenshot_is_reported_and_the_rest_still_show() {
        let f = setup(standard()).await;
        let mut bad = png();
        bad[12] ^= 1; // same size, different bytes
        f.mock.serve(&format!("{BASE}apps/{APP}/a.png"), &bad);
        let d = f.client.app_detail(ID, APP).await.unwrap();
        assert!(d.screenshots[0].data_url.is_none());
        assert!(
            d.screenshots[0].error.as_deref().unwrap().contains("hash"),
            "{:?}",
            d.screenshots[0].error
        );
        assert!(
            d.screenshots[1].data_url.is_some(),
            "the good screenshot must still show"
        );
        assert!(d.manual.is_some());
    }

    #[tokio::test]
    async fn screenshot_failures_of_every_kind_leave_the_page_usable() {
        for (name, script) in [
            ("404", Script::Status(404)),
            ("down", Script::Down("offline".into())),
            ("longer", Script::Ok([png(), b"extra".to_vec()].concat())),
            (
                "endless",
                Script::Chunks {
                    declared_len: None,
                    chunks: (0..1000).map(|_| vec![0u8; 4096]).collect(),
                    delay: std::time::Duration::ZERO,
                },
            ),
        ] {
            let f = setup(standard()).await;
            f.mock.route(&format!("{BASE}apps/{APP}/a.png"), script);
            let d = f.client.app_detail(ID, APP).await.unwrap();
            assert!(d.screenshots[0].data_url.is_none(), "{name}");
            assert!(d.screenshots[0].error.is_some(), "{name}");
            assert!(d.screenshots[1].data_url.is_some(), "{name}");
        }
    }

    #[tokio::test]
    async fn a_manual_that_fails_its_check_is_withheld() {
        let f = setup(standard()).await;
        let mut bad = standard().manual.unwrap();
        bad[3] ^= 1;
        f.mock.serve(&format!("{BASE}apps/{APP}/manual.md"), &bad);
        let d = f.client.app_detail(ID, APP).await.unwrap();
        assert!(d.manual.is_none());
        assert!(d.manual_error.is_some());
        assert_eq!(d.screenshots.len(), 2);
    }

    #[tokio::test]
    async fn an_image_that_is_not_what_its_name_says_is_not_shown() {
        // The bytes match the hash in the index (a publisher mistake or a hostile publisher),
        // but a "png" that is not a PNG must not reach the interface.
        let f = setup(Files {
            manual: None,
            shots: vec![("a.png".into(), b"<html>not an image</html>".to_vec())],
            icon: None,
        })
        .await;
        let d = f.client.app_detail(ID, APP).await.unwrap();
        assert!(d.screenshots[0].data_url.is_none());
        assert!(d.screenshots[0]
            .error
            .as_deref()
            .unwrap()
            .contains("not a PNG"));
    }

    #[test]
    fn svg_icons_with_anything_active_are_refused() {
        assert!(image_data_url("a.svg", SVG.as_bytes()).is_ok());
        for bad in [
            "<svg><script>alert(1)</script></svg>",
            "<svg onload='x()'></svg>",
            "<svg><a href='https://x.test'><rect/></a></svg>",
            "<svg><image href='https://x.test/a.png'/></svg>",
            "<svg><foreignObject><div/></foreignObject></svg>",
            "<svg><style>@import url(x)</style></svg>",
            "<svg><use xlink:href='#a'/></svg>",
            "<html><svg/></html>",
            "",
        ] {
            assert!(
                image_data_url("a.svg", bad.as_bytes()).is_err(),
                "accepted {bad}"
            );
        }
        assert!(image_data_url("a.svg", &[0xff, 0xfe, 0x00]).is_err());
        assert!(image_data_url("a.gif", b"GIF89a").is_err());
        assert!(image_data_url("a.webp", b"RIFF....WAVE").is_err());
        assert!(image_data_url("a.webp", &webp()).is_ok());
        assert!(image_data_url("a.png", &png()).is_ok());
    }

    #[tokio::test]
    async fn unknown_apps_and_registries_are_clear_errors() {
        let f = setup(standard()).await;
        assert_eq!(
            f.client
                .app_detail(ID, "sh.test.ghost")
                .await
                .unwrap_err()
                .code(),
            "app_not_found"
        );
        assert_eq!(
            f.client
                .app_detail("registry:no.such", APP)
                .await
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    #[tokio::test]
    async fn a_modified_cache_stops_the_detail_page() {
        let f = setup(standard()).await;
        let row = super::super::store::get(&f.pool, ID)
            .await
            .unwrap()
            .unwrap();
        let mut bad = row.index_json.clone();
        let i = bad.len() / 2;
        bad[i] ^= 1;
        sqlx::query("UPDATE registries SET index_json = ? WHERE id = ?")
            .bind(bad)
            .bind(ID)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(f.client.app_detail(ID, APP).await.is_err());
    }

    #[tokio::test]
    async fn the_detail_serialises_for_the_interface() {
        let f = setup(standard()).await;
        let v = serde_json::to_value(f.client.app_detail(ID, APP).await.unwrap()).unwrap();
        for k in [
            "appId",
            "name",
            "description",
            "homepage",
            "source",
            "license",
            "changelog",
            "manual",
            "manualError",
            "screenshots",
            "icon",
            "iconError",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert!(v["screenshots"][0].get("dataUrl").is_some());
        assert_eq!(v["changelog"][0]["changes"][0]["type"], "added");
    }
}
