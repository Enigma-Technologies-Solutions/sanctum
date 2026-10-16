// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! The `sanctum://install` link: `sanctum://install?app=<app_id>[&registry=<base url>]`.
//!
//! A link is an *invitation*, never an instruction. Parsing it only produces a request to
//! show the user a confirmation; it does no network request, installs nothing and grants
//! nothing. Anything we do not fully understand is refused, because the link comes from
//! outside the app (a web page, an email, a Markdown file, another program) and may be
//! written by anyone.
//!
//! - `app` is required and must be a registry app id.
//! - `registry` is optional. Absent means the Enigma public registry. Present means a base
//!   URL that must be HTTPS and end with `/`. Whether it is Enigma's is decided by comparing
//!   the parsed URL with the compiled-in one, never by looking for a name inside the text.
//! - Repeated keys, unknown keys, credentials, ports on the scheme, fragments and paths other
//!   than `/` are all refused. Total length is capped.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use url::Url;

use super::fetch::check_url;

/// The Enigma public registry. A link without `registry` means this one.
pub const ENIGMA_REGISTRY_URL: &str = "https://sanctum.enigma.sh/registry/v1/";

pub const SCHEME: &str = "sanctum";
pub const MAX_LINK_LEN: usize = 2048;
const MAX_APP_ID: usize = 100;
const MAX_REGISTRY_URL: usize = 300;

/// What the link asks for, after validation. The user still has to confirm every step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub app_id: String,
    /// Canonical base URL, ending in `/`.
    pub registry_url: String,
    /// True only when `registry_url` is exactly the compiled-in Enigma registry.
    pub is_enigma: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    TooLong,
    NotALink,
    WrongScheme,
    UnknownAction,
    Unsupported(&'static str),
    MissingApp,
    BadApp,
    BadRegistry(&'static str),
    Duplicate(String),
    UnknownKey(String),
}

impl LinkError {
    /// A short stable code for logs and tests.
    pub fn code(&self) -> &'static str {
        match self {
            LinkError::TooLong => "too_long",
            LinkError::NotALink => "not_a_link",
            LinkError::WrongScheme => "wrong_scheme",
            LinkError::UnknownAction => "unknown_action",
            LinkError::Unsupported(_) => "unsupported",
            LinkError::MissingApp => "missing_app",
            LinkError::BadApp => "bad_app",
            LinkError::BadRegistry(_) => "bad_registry",
            LinkError::Duplicate(_) => "duplicate",
            LinkError::UnknownKey(_) => "unknown_key",
        }
    }
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Plain words for the person who clicked. Nothing from the link is echoed back, so a
        // hostile link cannot put its own text on screen through an error message.
        match self {
            LinkError::TooLong => write!(f, "This link is too long to be a Sanctum install link."),
            LinkError::NotALink => write!(f, "This is not a link Sanctum can read."),
            LinkError::WrongScheme => write!(f, "This is not a Sanctum link."),
            LinkError::UnknownAction => write!(f, "Sanctum does not know what this link asks for."),
            LinkError::Unsupported(why) => {
                write!(f, "This link has a part Sanctum does not accept: {why}.")
            }
            LinkError::MissingApp => write!(f, "This link does not say which tool to install."),
            LinkError::BadApp => write!(
                f,
                "This link names a tool in a form Sanctum does not accept."
            ),
            LinkError::BadRegistry(why) => {
                write!(f, "This link names a registry Sanctum cannot use: {why}.")
            }
            LinkError::Duplicate(_) => write!(
                f,
                "This link repeats a part, so Sanctum will not guess which one is meant."
            ),
            LinkError::UnknownKey(_) => write!(
                f,
                "This link has a part Sanctum does not know, so it was not opened."
            ),
        }
    }
}

impl std::error::Error for LinkError {}

fn app_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9]+(\.[a-z0-9-]+)+$").unwrap())
}

fn registry_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Same shape the registry format allows for a base URL (common.schema.json "httpsBase").
    RE.get_or_init(|| {
        Regex::new(r"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?/$").unwrap()
    })
}

/// Parse and validate a link. Pure: no I/O.
pub fn parse(raw: &str) -> Result<InstallRequest, LinkError> {
    if raw.len() > MAX_LINK_LEN {
        return Err(LinkError::TooLong);
    }
    if raw.chars().any(|c| c.is_control()) || raw != raw.trim() {
        return Err(LinkError::NotALink);
    }
    let url = Url::parse(raw).map_err(|_| LinkError::NotALink)?;
    if url.scheme() != SCHEME {
        return Err(LinkError::WrongScheme);
    }
    // The action sits where a host would be: sanctum://install?...
    match url.host_str() {
        Some(h) if h.eq_ignore_ascii_case("install") => {}
        _ => return Err(LinkError::UnknownAction),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(LinkError::Unsupported("a user name or password"));
    }
    if url.port().is_some() {
        return Err(LinkError::Unsupported("a port number"));
    }
    if url.fragment().is_some() {
        return Err(LinkError::Unsupported("a # part"));
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return Err(LinkError::Unsupported("a path"));
    }

    let mut app: Option<String> = None;
    let mut registry: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "app" => {
                if app.replace(v.into_owned()).is_some() {
                    return Err(LinkError::Duplicate("app".into()));
                }
            }
            "registry" => {
                if registry.replace(v.into_owned()).is_some() {
                    return Err(LinkError::Duplicate("registry".into()));
                }
            }
            other => return Err(LinkError::UnknownKey(other.chars().take(32).collect())),
        }
    }

    let app_id = app.ok_or(LinkError::MissingApp)?;
    if app_id.is_empty() {
        return Err(LinkError::MissingApp);
    }
    if app_id.len() > MAX_APP_ID || !app_id_re().is_match(&app_id) {
        return Err(LinkError::BadApp);
    }

    let registry_url = match registry {
        None => ENIGMA_REGISTRY_URL.to_string(),
        Some(r) => {
            if r.len() > MAX_REGISTRY_URL {
                return Err(LinkError::BadRegistry("the address is too long"));
            }
            if !registry_re().is_match(&r) {
                return Err(LinkError::BadRegistry(
                    "it must be an https address ending in /",
                ));
            }
            // Same rules the fetcher applies to any address, so a link cannot name one the
            // client would refuse later.
            let parsed = check_url(&r, false)
                .map_err(|_| LinkError::BadRegistry("the address is not allowed"))?;
            parsed.to_string()
        }
    };

    let is_enigma = registry_url == ENIGMA_REGISTRY_URL;
    Ok(InstallRequest {
        app_id,
        registry_url,
        is_enigma,
    })
}

/// What the app tells the window about a link it received.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkEvent {
    Install { request: InstallRequest },
    Refused { message: String, code: String },
}

pub fn to_event(raw: &str) -> LinkEvent {
    match parse(raw) {
        Ok(request) => LinkEvent::Install { request },
        Err(e) => LinkEvent::Refused {
            message: e.to_string(),
            code: e.code().to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> InstallRequest {
        parse(raw).unwrap_or_else(|e| panic!("{raw:?} should parse, got {e:?}"))
    }
    fn err(raw: &str) -> LinkError {
        parse(raw).expect_err(&format!("{raw:?} should be refused"))
    }

    #[test]
    fn the_plain_link_means_the_enigma_registry() {
        let r = ok("sanctum://install?app=sh.enigma.shamir");
        assert_eq!(r.app_id, "sh.enigma.shamir");
        assert_eq!(r.registry_url, ENIGMA_REGISTRY_URL);
        assert!(r.is_enigma);
    }

    #[test]
    fn a_trailing_slash_and_any_case_for_the_action_are_fine() {
        assert!(ok("sanctum://install/?app=sh.enigma.shamir").is_enigma);
        assert!(ok("sanctum://INSTALL?app=sh.enigma.shamir").is_enigma);
        assert!(ok("SANCTUM://install?app=sh.enigma.shamir").is_enigma);
    }

    #[test]
    fn naming_the_enigma_registry_explicitly_is_the_same_as_leaving_it_out() {
        let r = ok("sanctum://install?app=sh.enigma.shamir&registry=https%3A%2F%2Fsanctum.enigma.sh%2Fregistry%2Fv1%2F");
        assert!(r.is_enigma);
        assert_eq!(r.registry_url, ENIGMA_REGISTRY_URL);
        // host case does not matter once parsed
        assert!(ok("sanctum://install?app=sh.enigma.shamir&registry=https://SANCTUM.Enigma.SH/registry/v1/").is_enigma);
    }

    #[test]
    fn another_registry_is_not_enigma() {
        let r = ok("sanctum://install?app=com.example.tool&registry=https://tools.example.com/registry/v1/");
        assert!(!r.is_enigma);
        assert_eq!(r.registry_url, "https://tools.example.com/registry/v1/");
        assert_eq!(r.app_id, "com.example.tool");
    }

    #[test]
    fn look_alike_hosts_are_not_enigma() {
        for host in [
            "sanctum.enigma.sh.evil.example",
            "sanctum-enigma.sh",
            "sanctum.enigma.sh-evil.example",
            "evil.example/sanctum.enigma.sh",
            "sanctum.enigma.sh.",
        ] {
            let raw = format!(
                "sanctum://install?app=sh.enigma.shamir&registry=https://{host}/registry/v1/"
            );
            // refusing is also fine; accepting must never mean "Enigma"
            if let Ok(r) = parse(&raw) {
                assert!(!r.is_enigma, "{host} must not count as Enigma");
            }
        }
        // a name inside the path or query does not count either
        let r = ok("sanctum://install?app=sh.enigma.shamir&registry=https://evil.example/sanctum.enigma.sh/registry/v1/");
        assert!(!r.is_enigma);
    }

    #[test]
    fn other_schemes_and_shapes_are_refused() {
        assert_eq!(
            err("https://install?app=sh.enigma.shamir"),
            LinkError::WrongScheme
        );
        assert_eq!(
            err("sanctum2://install?app=sh.enigma.shamir"),
            LinkError::WrongScheme
        );
        assert_eq!(err("javascript:alert(1)"), LinkError::WrongScheme);
        assert_eq!(err("file:///etc/passwd"), LinkError::WrongScheme);
        assert_eq!(err("data:text/html,x"), LinkError::WrongScheme);
        assert_eq!(err("install?app=sh.enigma.shamir"), LinkError::NotALink);
        assert_eq!(err(""), LinkError::NotALink);
        assert_eq!(err("sanctum:"), LinkError::UnknownAction);
        assert_eq!(
            err("sanctum:install?app=sh.enigma.shamir"),
            LinkError::UnknownAction
        );
    }

    #[test]
    fn only_the_install_action_exists() {
        for raw in [
            "sanctum://open?app=sh.enigma.shamir",
            "sanctum://run?app=sh.enigma.shamir",
            "sanctum://uninstall?app=sh.enigma.shamir",
            "sanctum://approve?app=sh.enigma.shamir",
            "sanctum://evil.example?app=sh.enigma.shamir",
            "sanctum://install.evil.example?app=sh.enigma.shamir",
            "sanctum://xinstall?app=sh.enigma.shamir",
        ] {
            assert_eq!(err(raw), LinkError::UnknownAction, "{raw}");
        }
    }

    #[test]
    fn credentials_ports_paths_and_fragments_are_refused() {
        assert!(matches!(
            err("sanctum://user@install?app=sh.enigma.shamir"),
            LinkError::Unsupported(_)
        ));
        assert!(matches!(
            err("sanctum://user:pw@install?app=sh.enigma.shamir"),
            LinkError::Unsupported(_)
        ));
        assert!(matches!(
            err("sanctum://install:8080?app=sh.enigma.shamir"),
            LinkError::Unsupported(_)
        ));
        assert!(matches!(
            err("sanctum://install/extra?app=sh.enigma.shamir"),
            LinkError::Unsupported(_)
        ));
        assert!(matches!(
            err("sanctum://install/../x?app=sh.enigma.shamir"),
            LinkError::Unsupported(_)
        ));
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir#x"),
            LinkError::Unsupported(_)
        ));
        // "install" as a user name does not make evil.example the action
        assert_eq!(
            err("sanctum://install@evil.example?app=sh.enigma.shamir"),
            LinkError::UnknownAction
        );
        assert_eq!(
            err("sanctum://evil.example@install?app=sh.enigma.shamir").code(),
            "unsupported"
        );
    }

    #[test]
    fn app_is_required_and_strictly_shaped() {
        assert_eq!(err("sanctum://install"), LinkError::MissingApp);
        assert_eq!(err("sanctum://install?"), LinkError::MissingApp);
        assert_eq!(err("sanctum://install?app="), LinkError::MissingApp);
        for bad in [
            "Sh.Enigma.Shamir",        // upper case
            "shamir",                  // no dot
            "sh.enigma.shamir ",       // trailing space
            "sh.enigma.shamir%00",     // NUL
            "sh.enigma./shamir",       // slash
            "../sh.enigma.shamir",     // traversal
            "sh..enigma",              // empty label
            ".sh.enigma",              // leading dot
            "sh.enigma.shamir/",       // trailing slash
            "sh.enigma.shamir;rm",     // shell-ish
            "sh.enigma.sh%C3%A4mir",   // non-ASCII
            "sh.enigma.shamir%0Aevil", // newline
            "s%68.enigma.shamir%2F..", // encoded slash
            "sh.enigma.<script>",      // markup
        ] {
            let raw = format!("sanctum://install?app={bad}");
            assert!(
                matches!(
                    err(&raw),
                    LinkError::BadApp | LinkError::NotALink | LinkError::MissingApp
                ),
                "{bad}"
            );
        }
        // 100 characters is the schema's limit
        let at_limit = format!("a.{}", "b".repeat(98));
        assert_eq!(at_limit.len(), 100);
        assert!(parse(&format!("sanctum://install?app={at_limit}")).is_ok());
        let over = format!("a.{}", "b".repeat(99));
        assert_eq!(
            err(&format!("sanctum://install?app={over}")),
            LinkError::BadApp
        );
    }

    #[test]
    fn registry_must_be_a_clean_https_base_url() {
        let cases: &[(&str, &str)] = &[
            ("http://sanctum.enigma.sh/registry/v1/", "plain http"),
            ("ftp://sanctum.enigma.sh/registry/v1/", "other scheme"),
            ("https://sanctum.enigma.sh/registry/v1", "no trailing slash"),
            ("https://user@sanctum.enigma.sh/registry/v1/", "credentials"),
            ("https://user:pw@evil.example/", "credentials"),
            (
                "https://sanctum.enigma.sh@evil.example/registry/v1/",
                "credentials look-alike",
            ),
            ("https://evil.example/registry/v1/?x=1", "query"),
            ("https://evil.example/registry/v1/#x", "fragment"),
            ("https://evil.example/a b/", "space"),
            ("https://evil.example/%2e%2e/", "encoded dots"),
            ("https://", "no host"),
            ("https:///registry/", "empty host"),
            ("//evil.example/", "no scheme"),
            ("javascript:alert(1)//", "javascript"),
            ("https://evil.example:99999/", "port out of range"),
            ("https://exämple.com/", "non-ASCII host"),
            (
                "HTTPS://sanctum.enigma.sh/registry/v1/",
                "upper case scheme",
            ),
            ("", "empty"),
        ];
        for (reg, what) in cases {
            let raw = format!(
                "sanctum://install?app=sh.enigma.shamir&registry={}",
                url::form_urlencoded::byte_serialize(reg.as_bytes()).collect::<String>()
            );
            assert!(
                matches!(err(&raw), LinkError::BadRegistry(_)),
                "{what}: {reg}"
            );
        }
    }

    #[test]
    fn double_encoding_is_not_decoded_twice() {
        // %2568 is a literal "%68", not an "h": the value does not start with https
        let raw = "sanctum://install?app=sh.enigma.shamir&registry=%2568ttps://evil.example/";
        assert!(matches!(err(raw), LinkError::BadRegistry(_)));
        let raw = "sanctum://install?app=sh%252Eenigma.shamir";
        assert_eq!(err(raw), LinkError::BadApp);
    }

    #[test]
    fn repeated_and_unknown_keys_are_refused() {
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&app=sh.enigma.otp-vault"),
            LinkError::Duplicate(_)
        ));
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&registry=https://a.example/&registry=https://b.example/"),
            LinkError::Duplicate(_)
        ));
        // the same key spelled twice with different case is a different, unknown key
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&APP=x"),
            LinkError::UnknownKey(_)
        ));
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&approve=1"),
            LinkError::UnknownKey(_)
        ));
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&yes=1"),
            LinkError::UnknownKey(_)
        ));
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&silent=true"),
            LinkError::UnknownKey(_)
        ));
        assert!(matches!(
            err("sanctum://install?app=sh.enigma.shamir&version=1.0.2"),
            LinkError::UnknownKey(_)
        ));
    }

    #[test]
    fn size_limits_hold() {
        let long = format!(
            "sanctum://install?app=sh.enigma.shamir&registry=https://{}.example/",
            "a".repeat(2100)
        );
        assert_eq!(err(&long), LinkError::TooLong);
        let big_registry = format!(
            "sanctum://install?app=sh.enigma.shamir&registry=https://{}.example/",
            "a".repeat(400)
        );
        assert!(matches!(err(&big_registry), LinkError::BadRegistry(_)));
        let junk = format!(
            "sanctum://install?app=sh.enigma.shamir&{}",
            "x=1&".repeat(600)
        );
        assert_eq!(err(&junk), LinkError::TooLong);
        let exactly = format!(
            "sanctum://install?app=sh.enigma.shamir&registry=https://a.example/{}/",
            "p".repeat(2048 - 90)
        );
        assert!(
            matches!(parse(&exactly), Err(LinkError::BadRegistry(_))),
            "path is too long for a registry address"
        );
    }

    #[test]
    fn control_characters_and_outer_whitespace_are_refused() {
        assert_eq!(
            err(" sanctum://install?app=sh.enigma.shamir"),
            LinkError::NotALink
        );
        assert_eq!(
            err("sanctum://install?app=sh.enigma.shamir\n"),
            LinkError::NotALink
        );
        assert_eq!(
            err("sanctum://install?app=sh.enigma.shamir\u{0}"),
            LinkError::NotALink
        );
        assert_eq!(
            err("sanctum://install?app=sh.enigma.shamir\r\nX: y"),
            LinkError::NotALink
        );
        assert_eq!(
            err("sanctum://install\t?app=sh.enigma.shamir"),
            LinkError::NotALink
        );
    }

    #[test]
    fn an_error_never_repeats_the_link_text() {
        // Whatever text a hostile link contains must not reach the screen through an error.
        let marker = "EVILMARKER";
        for raw in [
            format!("sanctum://install?app=sh.enigma.shamir&{marker}=1"),
            format!("sanctum://install?app=sh.enigma.shamir&app={marker}"),
            format!("sanctum://install?app={marker}"),
            format!("sanctum://{marker}?app=sh.enigma.shamir"),
            format!("sanctum://install?app=sh.enigma.shamir&registry=http://{marker}/"),
            format!("{marker}://install"),
        ] {
            let e = parse(&raw).expect_err("refused");
            assert!(!e.to_string().contains(marker), "{raw} leaked into: {e}");
            let LinkEvent::Refused { message, code } = to_event(&raw) else {
                panic!("expected a refusal")
            };
            assert!(!message.contains(marker) && !code.contains(marker));
        }
    }

    #[test]
    fn the_event_carries_the_request_or_a_refusal_and_nothing_else() {
        match to_event("sanctum://install?app=sh.enigma.shamir") {
            LinkEvent::Install { request } => assert_eq!(request.app_id, "sh.enigma.shamir"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            to_event("sanctum://install"),
            LinkEvent::Refused { .. }
        ));
        let json =
            serde_json::to_string(&to_event("sanctum://install?app=sh.enigma.shamir")).unwrap();
        assert!(
            json.contains("\"kind\":\"install\"")
                && json.contains("\"appId\"")
                && json.contains("\"isEnigma\":true"),
            "{json}"
        );
    }

    #[test]
    fn the_enigma_constant_is_a_valid_registry_address() {
        assert!(registry_re().is_match(ENIGMA_REGISTRY_URL));
        assert!(check_url(ENIGMA_REGISTRY_URL, false).is_ok());
    }
}
