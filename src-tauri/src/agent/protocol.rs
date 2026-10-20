// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! The slice of the Codex app-server protocol that Sanctum uses.
//!
//! The full schema from the Codex version we bundle is checked in under
//! `spec/codex-app-server/`; a test below fails if a method named here is missing from it, so
//! a Codex update that renames something is caught in CI, not by a user.
//!
//! Only the ChatGPT sign-in is expressible here. There is deliberately no way to build a
//! request that sends an API key or `chatgptAuthTokens` (the schema marks the latter "FOR
//! OPENAI INTERNAL USE ONLY"; using it would make Sanctum the holder of the token).

use super::AgentError;
use serde::Deserialize;
use serde_json::{json, Value};

pub const M_INITIALIZE: &str = "initialize";
pub const N_INITIALIZED: &str = "initialized";
pub const M_ACCOUNT_READ: &str = "account/read";
pub const M_LOGIN_START: &str = "account/login/start";
pub const M_LOGIN_CANCEL: &str = "account/login/cancel";
pub const M_LOGOUT: &str = "account/logout";
pub const N_LOGIN_COMPLETED: &str = "account/login/completed";

pub fn initialize_params(version: &str) -> Value {
    json!({
        "clientInfo": {"name": "sanctum", "title": "Sanctum", "version": version},
        "capabilities": {"experimentalApi": false}
    })
}

/// The only login Sanctum starts.
pub fn login_chatgpt_params() -> Value {
    json!({"type": "chatgpt"})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanType {
    Free,
    Go,
    Plus,
    Pro,
    Prolite,
    Team,
    SelfServeBusinessUsageBased,
    Business,
    EnterpriseCbpUsageBased,
    Enterprise,
    Edu,
    #[serde(other)]
    Unknown,
}

impl PlanType {
    /// A short name for the Settings card.
    pub fn label(self) -> &'static str {
        match self {
            PlanType::Free => "Free",
            PlanType::Go => "Go",
            PlanType::Plus => "Plus",
            PlanType::Pro => "Pro",
            PlanType::Prolite => "Pro Lite",
            PlanType::Team => "Team",
            PlanType::SelfServeBusinessUsageBased | PlanType::Business => "Business",
            PlanType::EnterpriseCbpUsageBased | PlanType::Enterprise => "Enterprise",
            PlanType::Edu => "Edu",
            PlanType::Unknown => "ChatGPT",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Account {
    Chatgpt {
        email: String,
        #[serde(rename = "planType")]
        plan_type: PlanType,
    },
    ApiKey,
    AmazonBedrock,
}

#[derive(Debug, Deserialize)]
pub struct GetAccountResponse {
    pub account: Option<Account>,
}

pub fn parse_account(v: Value) -> Result<Option<Account>, AgentError> {
    serde_json::from_value::<GetAccountResponse>(v)
        .map(|r| r.account)
        .map_err(|_| AgentError::Protocol("unexpected account answer".into()))
}

/// What `account/login/start` answers for the browser flow.
#[derive(Debug, PartialEq, Eq)]
pub struct LoginStarted {
    pub login_id: String,
    pub auth_url: String,
}

/// Accepts only the answer to a `chatgpt` login. Any other kind of answer is refused, so a
/// server that replies with a different mode cannot steer Sanctum into it.
pub fn parse_login_start(v: Value) -> Result<LoginStarted, AgentError> {
    let bad = || AgentError::Protocol("unexpected sign-in answer".into());
    if v.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return Err(bad());
    }
    let login_id = v
        .get("loginId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(bad)?;
    let auth_url = v
        .get("authUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(bad)?;
    Ok(LoginStarted {
        login_id: login_id.to_owned(),
        auth_url: auth_url.to_owned(),
    })
}

#[derive(Debug, Deserialize)]
pub struct LoginCompleted {
    #[serde(rename = "loginId")]
    pub login_id: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

/// The browser address Codex asks us to open. HTTPS only, a real host, no embedded
/// credentials. (A host allowlist comes after the traffic has been measured; see
/// docs/create-app-plan.md.)
pub fn validate_auth_url(raw: &str) -> Result<url::Url, AgentError> {
    let u = url::Url::parse(raw).map_err(|_| AgentError::BadAuthUrl)?;
    let ok = u.scheme() == "https"
        && u.host_str().is_some_and(|h| h.contains('.'))
        && u.username().is_empty()
        && u.password().is_none();
    if ok {
        Ok(u)
    } else {
        Err(AgentError::BadAuthUrl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str =
        include_str!("../../../spec/codex-app-server/codex_app_server_protocol.v2.schemas.json");
    const CLIENT_NOTIFICATIONS: &str =
        include_str!("../../../spec/codex-app-server/ClientNotification.json");

    #[test]
    fn every_method_we_use_exists_in_the_checked_in_schema() {
        for m in [
            M_INITIALIZE,
            M_ACCOUNT_READ,
            M_LOGIN_START,
            M_LOGIN_CANCEL,
            M_LOGOUT,
            N_LOGIN_COMPLETED,
        ] {
            assert!(
                SCHEMA.contains(&format!("\"{m}\"")),
                "{m} missing from the schema"
            );
        }
        assert!(
            CLIENT_NOTIFICATIONS.contains(&format!("\"{N_INITIALIZED}\"")),
            "initialized missing from the schema"
        );
    }

    #[test]
    fn login_params_are_only_the_browser_flow() {
        assert_eq!(login_chatgpt_params(), json!({"type": "chatgpt"}));
    }

    #[test]
    fn a_chatgpt_account_parses_with_its_plan() {
        let a = parse_account(json!({"account": {"type": "chatgpt", "email": "a@b.c", "planType": "pro"}, "requiresOpenaiAuth": true})).unwrap();
        match a {
            Some(Account::Chatgpt { email, plan_type }) => {
                assert_eq!(email, "a@b.c");
                assert_eq!(plan_type, PlanType::Pro);
                assert_eq!(plan_type.label(), "Pro");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn no_account_and_other_account_kinds_parse() {
        assert!(
            parse_account(json!({"account": null, "requiresOpenaiAuth": true}))
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            parse_account(json!({"account": {"type": "apiKey"}})).unwrap(),
            Some(Account::ApiKey)
        ));
        assert!(parse_account(json!({"account": 5})).is_err());
    }

    #[test]
    fn a_plan_we_do_not_know_is_not_an_error() {
        let a = parse_account(
            json!({"account": {"type": "chatgpt", "email": "a@b.c", "planType": "brand_new_plan"}}),
        )
        .unwrap();
        assert!(matches!(
            a,
            Some(Account::Chatgpt {
                plan_type: PlanType::Unknown,
                ..
            })
        ));
    }

    #[test]
    fn login_start_accepts_only_the_chatgpt_answer() {
        let ok = parse_login_start(
            json!({"type": "chatgpt", "loginId": "l1", "authUrl": "https://auth.example.com/x"}),
        )
        .unwrap();
        assert_eq!(
            ok,
            LoginStarted {
                login_id: "l1".into(),
                auth_url: "https://auth.example.com/x".into()
            }
        );
        for bad in [
            json!({"type": "chatgptAuthTokens"}),
            json!({"type": "chatgptAuthTokens", "loginId": "l", "authUrl": "https://a.example.com/"}),
            json!({"type": "apiKey", "loginId": "l", "authUrl": "https://a.example.com/"}),
            json!({"loginId": "l", "authUrl": "https://a.example.com/"}),
            json!({"type": "chatgptDeviceCode", "loginId": "l", "userCode": "c", "verificationUrl": "https://a.b"}),
            json!({"type": "chatgpt", "loginId": "", "authUrl": "https://a.b"}),
            json!({"type": "chatgpt", "loginId": "l"}),
            json!({}),
        ] {
            assert!(
                parse_login_start(bad.clone()).is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn auth_urls_must_be_plain_https() {
        assert!(validate_auth_url("https://auth.example.com/oauth/authorize?x=1").is_ok());
        for bad in [
            "http://auth.example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pw@auth.example.com/",
            "https://user@auth.example.com/",
            "https://localhost/",
            "https:///nohost",
            "not a url",
        ] {
            assert!(validate_auth_url(bad).is_err(), "{bad} should be refused");
        }
    }
}
