// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Account state and the ChatGPT sign-in, over an [`Rpc`] connection.
//!
//! Sanctum never sees a token. It asks Codex to start the browser flow, opens the address
//! Codex gives it, and waits for Codex to say the sign-in finished. Codex stores and refreshes
//! the credentials itself, inside its own `CODEX_HOME`.

use super::protocol::*;
use super::rpc::{Rpc, RpcError, CLOSED_EVENT};
use super::AgentError;
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::RecvError;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a person gets to finish signing in, in the browser.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub signed_in: bool,
    pub email: Option<String>,
    /// Plan name such as "Pro", ready to show.
    pub plan: Option<String>,
}

impl Status {
    fn signed_out() -> Status {
        Status {
            signed_in: false,
            email: None,
            plan: None,
        }
    }
}

pub async fn status(rpc: &Rpc) -> Result<Status, AgentError> {
    let v = rpc
        .request(
            M_ACCOUNT_READ,
            json!({"refreshToken": false}),
            REQUEST_TIMEOUT,
        )
        .await?;
    Ok(match parse_account(v)? {
        Some(Account::Chatgpt { email, plan_type }) => Status {
            signed_in: true,
            email: Some(email),
            plan: Some(plan_type.label().to_owned()),
        },
        // An API key or another provider is not a ChatGPT sign-in. Sanctum offers only that.
        _ => Status::signed_out(),
    })
}

/// Best effort; the sign-in is already over when this matters.
pub async fn cancel_login(rpc: &Rpc, login_id: &str) {
    let _ = rpc
        .request(
            M_LOGIN_CANCEL,
            json!({"loginId": login_id}),
            REQUEST_TIMEOUT,
        )
        .await;
}

pub async fn sign_out(rpc: &Rpc) -> Result<(), AgentError> {
    rpc.request(M_LOGOUT, json!({}), REQUEST_TIMEOUT).await?;
    Ok(())
}

/// Runs the browser sign-in. `open` receives the validated address and must show it to the
/// person in their browser. Returns the account once Codex reports success.
pub async fn sign_in<F>(rpc: &Rpc, open: F, timeout: Duration) -> Result<Status, AgentError>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    // Subscribe first: the completion can arrive before the answer to the start request is
    // processed on a fast machine.
    let mut events = rpc.subscribe();
    let started = parse_login_start(
        rpc.request(M_LOGIN_START, login_chatgpt_params(), REQUEST_TIMEOUT)
            .await?,
    )?;
    let url = match validate_auth_url(&started.auth_url) {
        Ok(u) => u,
        Err(e) => {
            cancel_login(rpc, &started.login_id).await;
            return Err(e);
        }
    };
    if let Err(e) = open(url.as_str()) {
        cancel_login(rpc, &started.login_id).await;
        return Err(AgentError::Browser(e));
    }

    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, events.recv()).await {
            Err(_) => {
                cancel_login(rpc, &started.login_id).await;
                return Err(AgentError::LoginTimeout);
            }
            Ok(Err(RecvError::Closed)) => return Err(AgentError::Rpc(RpcError::Closed)),
            Ok(Err(RecvError::Lagged(_))) => continue,
            Ok(Ok(n)) if n.method == N_LOGIN_COMPLETED => {
                let Ok(done) = serde_json::from_value::<LoginCompleted>(n.params) else {
                    continue;
                };
                if done.login_id.as_deref() != Some(started.login_id.as_str()) {
                    continue;
                }
                if !done.success {
                    let why = done
                        .error
                        .unwrap_or_else(|| "sign-in was not completed".into());
                    return Err(AgentError::LoginFailed(why.chars().take(300).collect()));
                }
                return status(rpc).await;
            }
            Ok(Ok(n)) if n.method == CLOSED_EVENT => return Err(AgentError::Rpc(RpcError::Closed)),
            Ok(Ok(_)) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::rpc::testing::pair;
    use super::*;
    use std::sync::{Arc, Mutex};

    const T: Duration = Duration::from_secs(5);
    const URL: &str = "https://auth.example.com/authorize?state=1";

    fn started(id: &str) -> serde_json::Value {
        json!({"type": "chatgpt", "loginId": id, "authUrl": URL})
    }
    fn account() -> serde_json::Value {
        json!({"account": {"type": "chatgpt", "email": "me@example.com", "planType": "pro"}, "requiresOpenaiAuth": true})
    }
    fn completed(id: &str, ok: bool) -> serde_json::Value {
        json!({"method": "account/login/completed", "params": {"loginId": id, "success": ok, "error": if ok { serde_json::Value::Null } else { json!("denied") }}})
    }

    #[tokio::test]
    async fn status_reports_signed_out_and_signed_in() {
        let (rpc, mut fake) = pair();
        let rpc = Arc::new(rpc);
        let r = rpc.clone();
        let t = tokio::spawn(async move { status(&r).await });
        let req = fake
            .answer(json!({"account": null, "requiresOpenaiAuth": true}))
            .await;
        assert_eq!(req["method"], "account/read");
        assert_eq!(req["params"]["refreshToken"], false);
        assert_eq!(
            t.await.unwrap().unwrap(),
            Status {
                signed_in: false,
                email: None,
                plan: None
            }
        );

        let r = rpc.clone();
        let t = tokio::spawn(async move { status(&r).await });
        fake.answer(account()).await;
        let s = t.await.unwrap().unwrap();
        assert!(s.signed_in);
        assert_eq!(s.email.as_deref(), Some("me@example.com"));
        assert_eq!(s.plan.as_deref(), Some("Pro"));
    }

    #[tokio::test]
    async fn an_api_key_account_is_not_a_chatgpt_sign_in() {
        let (rpc, mut fake) = pair();
        let t = tokio::spawn(async move { status(&rpc).await });
        fake.answer(json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": false}))
            .await;
        assert!(!t.await.unwrap().unwrap().signed_in);
    }

    #[tokio::test]
    async fn sign_in_opens_the_browser_then_waits_for_the_matching_completion() {
        let (rpc, mut fake) = pair();
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let o = opened.clone();
        let t = tokio::spawn(async move {
            sign_in(
                &rpc,
                move |u| {
                    o.lock().unwrap().push(u.to_owned());
                    Ok(())
                },
                T,
            )
            .await
        });
        let req = fake.answer(started("L1")).await;
        assert_eq!(req["method"], "account/login/start");
        assert_eq!(req["params"], json!({"type": "chatgpt"}));
        // Someone else's completion, and an unrelated notification, are ignored.
        fake.send(completed("OTHER", false)).await;
        fake.send(json!({"method": "account/updated", "params": {}}))
            .await;
        fake.send(completed("L1", true)).await;
        let req = fake.answer(account()).await;
        assert_eq!(req["method"], "account/read");
        let s = t.await.unwrap().unwrap();
        assert!(s.signed_in);
        assert_eq!(opened.lock().unwrap().as_slice(), [URL]);
    }

    #[tokio::test]
    async fn a_failed_sign_in_reports_why() {
        let (rpc, mut fake) = pair();
        let t = tokio::spawn(async move { sign_in(&rpc, |_| Ok(()), T).await });
        fake.answer(started("L1")).await;
        fake.send(completed("L1", false)).await;
        match t.await.unwrap() {
            Err(AgentError::LoginFailed(m)) => assert_eq!(m, "denied"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unsafe_address_is_never_opened_and_the_login_is_cancelled() {
        let (rpc, mut fake) = pair();
        let opened = Arc::new(Mutex::new(0u32));
        let o = opened.clone();
        let t = tokio::spawn(async move {
            sign_in(
                &rpc,
                move |_| {
                    *o.lock().unwrap() += 1;
                    Ok(())
                },
                T,
            )
            .await
        });
        fake.answer(
            json!({"type": "chatgpt", "loginId": "L9", "authUrl": "http://evil.example.com/"}),
        )
        .await;
        let cancel = fake.answer(json!({"status": "canceled"})).await;
        assert_eq!(cancel["method"], "account/login/cancel");
        assert_eq!(cancel["params"]["loginId"], "L9");
        assert!(matches!(t.await.unwrap(), Err(AgentError::BadAuthUrl)));
        assert_eq!(*opened.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_wrong_kind_of_login_answer_is_refused() {
        let (rpc, mut fake) = pair();
        let t = tokio::spawn(async move { sign_in(&rpc, |_| Ok(()), T).await });
        fake.answer(json!({"type": "chatgptAuthTokens"})).await;
        assert!(matches!(t.await.unwrap(), Err(AgentError::Protocol(_))));
    }

    #[tokio::test]
    async fn a_browser_that_cannot_open_cancels_the_login() {
        let (rpc, mut fake) = pair();
        let t = tokio::spawn(async move { sign_in(&rpc, |_| Err("no browser".into()), T).await });
        fake.answer(started("L1")).await;
        let cancel = fake.answer(json!({"status": "canceled"})).await;
        assert_eq!(cancel["method"], "account/login/cancel");
        assert!(matches!(t.await.unwrap(), Err(AgentError::Browser(m)) if m == "no browser"));
    }

    #[tokio::test]
    async fn waiting_too_long_cancels_the_login() {
        let (rpc, mut fake) = pair();
        let t =
            tokio::spawn(async move { sign_in(&rpc, |_| Ok(()), Duration::from_millis(80)).await });
        fake.answer(started("L1")).await;
        let cancel = fake.answer(json!({"status": "canceled"})).await;
        assert_eq!(cancel["method"], "account/login/cancel");
        assert!(matches!(t.await.unwrap(), Err(AgentError::LoginTimeout)));
    }

    #[tokio::test]
    async fn a_process_that_dies_mid_sign_in_is_reported() {
        let (rpc, mut fake) = pair();
        let t = tokio::spawn(async move { sign_in(&rpc, |_| Ok(()), T).await });
        fake.answer(started("L1")).await;
        fake.close();
        assert!(matches!(
            t.await.unwrap(),
            Err(AgentError::Rpc(RpcError::Closed))
        ));
    }

    #[tokio::test]
    async fn sign_out_sends_logout() {
        let (rpc, mut fake) = pair();
        let t = tokio::spawn(async move { sign_out(&rpc).await });
        let req = fake.answer(json!({})).await;
        assert_eq!(req["method"], "account/logout");
        t.await.unwrap().unwrap();
    }
}
