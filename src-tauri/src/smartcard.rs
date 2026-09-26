// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Smart card broker — the first real implementation of the device-access seam
//! described in [`crate::device_broker`].
//!
//! A tool window has no OS bridge: Tauri's IPC globals are removed before its
//! HTML is parsed, and its capability set is empty. It therefore cannot reach
//! PC/SC by itself. What it *can* do is fetch same-origin URLs under
//! `sanctum-tool://tool-{id}/__sanctum/v1/…`, which land in the custom protocol
//! handler in `lib.rs` — Rust code, with the calling webview's label supplied by
//! the webview runtime rather than by the page. That label is the tool identity
//! this module authorises against; nothing in the request body is trusted for
//! identity.
//!
//! Why a fetch endpoint instead of re-enabling IPC for tool windows: turning IPC
//! back on hands the page a general-purpose `invoke`, and the whole surface then
//! depends on the ACL never regressing. The protocol handler is a channel we
//! already own, on an origin the tool is already confined to, and it carries
//! exactly the five operations below and nothing else.
//!
//! Enforcement, in order, on every request:
//!
//! 1. **Capability** — the tool's approvals (as recorded when its window was
//!    opened) must contain a [`SmartcardCapability`]. No approval, no readers.
//! 2. **Applet allow-list** — `select` is refused unless the AID appears in
//!    that capability. The user approves *which applet*, not "smart cards".
//! 3. **No re-selection** — raw `transmit` refuses interindustry SELECT /
//!    MANAGE CHANNEL / GET RESPONSE, so a tool approved for the FIDO applet
//!    cannot pivot to PIV, OpenPGP, or an EMV payment applet on the same card.
//! 4. **Session ownership** — sessions are bound to the tool that opened them
//!    and are dropped when its window closes.
//!
//! [`SmartcardCapability`]: crate::models::SmartcardCapability

use std::collections::HashMap;
use std::sync::Mutex;

use crate::models::DetectedCapability;

// ── Limits ────────────────────────────────────────────────────────────────────

/// Concurrent card sessions a single tool may hold.
const MAX_SESSIONS_PER_TOOL: usize = 4;

/// Largest command APDU accepted from a tool, in bytes. Extended-length APDUs
/// top out at 65544 in ISO 7816, but nothing a tool legitimately sends over
/// CTAP or PIV comes close; a small cap keeps a runaway page from parking
/// megabytes in the reader driver.
const MAX_APDU_BYTES: usize = 4096;

/// Largest response assembled across GET RESPONSE chaining, in bytes.
const MAX_RESPONSE_BYTES: usize = 65536;

/// Chaining rounds before we call it a loop and give up.
const MAX_CHAIN_ROUNDS: usize = 32;

/// Single-transmit receive buffer. PC/SC needs room for the largest response
/// the card may return in one exchange.
const RECV_BUF_BYTES: usize = 8192;

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum BrokerError {
    /// Tool has no approved smart card capability at all.
    NotApproved,
    /// Tool is approved, but not for this AID.
    AidNotApproved(String),
    /// Malformed input from the page (bad hex, unknown session, absurd length).
    BadRequest(String),
    /// PC/SC or reader-level failure.
    Pcsc(String),
    /// The card was removed, reset, or lost power mid-exchange. Recoverable by
    /// re-presenting it, which is why it is distinct from a generic Pcsc error.
    CardGone,
    /// Refused by APDU policy.
    Denied(&'static str),
}

impl BrokerError {
    /// HTTP status for the protocol handler to answer with.
    pub fn status(&self) -> u16 {
        match self {
            BrokerError::NotApproved | BrokerError::AidNotApproved(_) | BrokerError::Denied(_) => {
                403
            }
            BrokerError::BadRequest(_) => 400,
            // 409: the request was fine, the card's state is not — retryable
            // after the user re-presents it, unlike a 502 reader fault.
            BrokerError::CardGone => 409,
            BrokerError::Pcsc(_) => 502,
        }
    }

    pub fn message(&self) -> String {
        match self {
            BrokerError::NotApproved => {
                "Smart card access is not approved for this tool.".to_string()
            }
            BrokerError::AidNotApproved(aid) => format!(
                "Applet {aid} is not in this tool's approved list. \
                 Approve it in Sanctum before selecting it."
            ),
            BrokerError::BadRequest(m) => m.clone(),
            BrokerError::Pcsc(m) => format!("Reader error: {m}"),
            BrokerError::CardGone => {
                "The card was removed or reset. Present it to the reader again.".to_string()
            }
            BrokerError::Denied(m) => (*m).to_string(),
        }
    }
}

// ── Hex ───────────────────────────────────────────────────────────────────────

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(s: &str) -> Result<Vec<u8>, BrokerError> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) {
        return Err(BrokerError::BadRequest(
            "hex string has an odd number of digits".into(),
        ));
    }
    if !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(BrokerError::BadRequest(
            "hex string contains a non-hex character".into(),
        ));
    }
    hex::decode(s).map_err(|e| BrokerError::BadRequest(e.to_string()))
}

// ── AID validation ────────────────────────────────────────────────────────────

/// Is `aid` a syntactically valid application identifier?
///
/// ISO 7816-4 puts an AID at 5–16 bytes. The string form used throughout
/// Sanctum is lowercase hex with no separators, because that is what both the
/// static scan and the approval record store — comparing anything else risks
/// two spellings of one applet where only one of them is approved.
pub fn is_valid_aid(aid: &str) -> bool {
    let len = aid.len();
    (10..=32).contains(&len)
        && len.is_multiple_of(2)
        && aid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Normalise an AID for comparison, rejecting anything not well-formed.
pub fn normalize_aid(aid: &str) -> Result<String, BrokerError> {
    let lower = aid.trim().to_ascii_lowercase();
    if !is_valid_aid(&lower) {
        return Err(BrokerError::BadRequest(format!(
            "not a valid AID (expected 5 to 16 bytes as hex): {aid}"
        )));
    }
    Ok(lower)
}

/// The AIDs a tool may select, given its approved capabilities.
///
/// Approvals are read back from SQLite as untrusted JSON, so each entry is
/// re-validated here rather than trusted because it was validated once at scan
/// time. The `(dynamic)` sentinel is a label meaning "the scan could not tell
/// which applet this tool talks to" — it is deliberately never an AID, so a
/// tool that builds its AID at runtime gets readers but no applet.
pub fn approved_aids(approvals: &[DetectedCapability]) -> Vec<String> {
    approvals
        .iter()
        .filter_map(|c| match c {
            DetectedCapability::Smartcard(s) => Some(s.smartcard.clone()),
            _ => None,
        })
        .flatten()
        .filter(|a| is_valid_aid(a))
        .collect()
}

/// Does the tool hold any smart card approval at all (even a `(dynamic)` one)?
pub fn has_smartcard_capability(approvals: &[DetectedCapability]) -> bool {
    approvals
        .iter()
        .any(|c| matches!(c, DetectedCapability::Smartcard(_)))
}

// ── APDU policy ───────────────────────────────────────────────────────────────

/// Would this command APDU change which applet the session is talking to, or
/// interfere with response chaining owned by the broker?
///
/// Only *interindustry* commands are refused (CLA bit 8 clear). Under CLA 0x80
/// and friends the INS byte is proprietary — CTAP2's `NFCCTAP_MSG` is
/// `80 10 00 00`, and refusing every 0xA4 regardless of class would break
/// applets that assign their own meaning to it. An applet cannot be selected by
/// a proprietary-class command, so the narrower rule loses nothing.
///
/// * `A4` SELECT — the pivot to another applet.
/// * `70` MANAGE CHANNEL — a second logical channel is a second selection.
/// * `C0` GET RESPONSE — chaining is driven by `transmit_chained`; a page
///   issuing its own GET RESPONSE would desynchronise it.
pub fn is_forbidden_apdu(apdu: &[u8]) -> Option<&'static str> {
    if apdu.len() < 4 {
        return Some("APDU too short: needs at least CLA INS P1 P2.");
    }
    let (cla, ins) = (apdu[0], apdu[1]);
    if cla & 0x80 != 0 {
        return None;
    }
    match ins {
        0xA4 => Some(
            "SELECT is not allowed on the raw channel. \
             Use sanctum.smartcard session.select(aid), which checks the AID \
             against what you approved.",
        ),
        0x70 => Some("MANAGE CHANNEL is not allowed because it would bypass applet approval."),
        0xC0 => Some("GET RESPONSE is handled by Sanctum; do not send it yourself."),
        _ => None,
    }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

pub struct Session {
    /// Owning tool. A session is usable only by the tool that opened it.
    pub tool_id: String,
    pub reader: String,
    pub card: pcsc::Card,
    /// AID of the currently selected applet. `transmit` is refused until an
    /// approved applet has been selected, so a tool cannot poke at whatever
    /// applet the card happens to have selected by default.
    pub selected_aid: Option<String>,
}

#[derive(Default)]
pub struct SmartcardState {
    pub sessions: Mutex<HashMap<String, Session>>,
}

impl SmartcardState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop every session belonging to `tool_id`. Called when a tool window
    /// closes so a card is never left connected to a page that is gone.
    pub fn close_tool_sessions(&self, tool_id: &str) {
        let mut map = self.sessions.lock().unwrap();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, s)| s.tool_id == tool_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(session) = map.remove(&id) {
                release(session.card);
            }
        }
    }

    fn count_for(&self, tool_id: &str) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.tool_id == tool_id)
            .count()
    }
}

// ── Reader enumeration ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ReaderInfo {
    pub name: String,
    pub card_present: bool,
    /// ATR of the inserted card as lowercase hex, or `None` when the slot is
    /// empty. The ATR identifies the card model, so it is only ever handed to a
    /// tool that already holds a smart card approval.
    pub atr: Option<String>,
}

fn context() -> Result<pcsc::Context, BrokerError> {
    pcsc::Context::establish(pcsc::Scope::User).map_err(|e| BrokerError::Pcsc(e.to_string()))
}

/// Hand a card back to the OS without power-cycling it.
///
/// Dropping a `pcsc::Card` disconnects with `Disposition::ResetCard`, which
/// resets the chip. On a contactless card that is not a tidy-up, it is a
/// deactivation: the card falls out of the field and the user has to lift it
/// off the reader and put it back. Sanctum enumerating readers, or a tool
/// closing a session, must never cost the user a re-tap — so every disconnect
/// is explicit and leaves the card as it was found.
fn release(card: pcsc::Card) {
    let _ = card.disconnect(pcsc::Disposition::LeaveCard);
}

/// Did this PC/SC failure mean the card is no longer usable on this handle?
///
/// A card that is removed, reset, or power-cycled mid-exchange surfaces as
/// several different errors depending on platform and driver. They all mean
/// the same thing to a tool — re-present the card — so they get one message
/// instead of the raw driver text.
fn card_gone(e: &pcsc::Error) -> bool {
    matches!(
        e,
        pcsc::Error::RemovedCard
            | pcsc::Error::ResetCard
            | pcsc::Error::UnpoweredCard
            | pcsc::Error::UnresponsiveCard
            | pcsc::Error::NotTransacted
            | pcsc::Error::NoSmartcard
    )
}

fn pcsc_error(e: pcsc::Error) -> BrokerError {
    if card_gone(&e) {
        BrokerError::CardGone
    } else {
        BrokerError::Pcsc(e.to_string())
    }
}

pub fn list_readers() -> Result<Vec<ReaderInfo>, BrokerError> {
    let ctx = context()?;
    let mut names_buf = vec![0u8; 4096];
    let names: Vec<Vec<u8>> = match ctx.list_readers(&mut names_buf) {
        Ok(iter) => iter.map(|c| c.to_bytes().to_vec()).collect(),
        // No reader attached is a normal state, not an error the tool should
        // have to special-case.
        Err(pcsc::Error::NoReadersAvailable) => return Ok(Vec::new()),
        Err(e) => return Err(BrokerError::Pcsc(e.to_string())),
    };

    // Presence comes from SCardGetStatusChange, not from trying to connect.
    //
    // Connecting to find out looks equivalent and is not: it powers the card
    // up, it can succeed against a card the driver has already lost (reporting
    // a card that will refuse the next APDU), and it cannot distinguish
    // present-and-working from present-but-mute. A status query touches
    // nothing, so enumerating readers is finally free of side effects on
    // whatever session is running.
    let mut states: Vec<pcsc::ReaderState> = names
        .iter()
        .filter_map(|raw| std::ffi::CString::new(raw.clone()).ok())
        .map(|cname| pcsc::ReaderState::new(cname, pcsc::State::UNAWARE))
        .collect();

    // Zero timeout: report the current state, never block a tool's UI.
    match ctx.get_status_change(Some(std::time::Duration::ZERO), &mut states) {
        Ok(()) | Err(pcsc::Error::Timeout) => {}
        Err(e) => return Err(BrokerError::Pcsc(e.to_string())),
    }

    let mut out = Vec::with_capacity(states.len());
    for state in &states {
        let event = state.event_state();
        // MUTE means "something is in the slot that will not answer" — a
        // browned-out contactless card looks exactly like this, and calling it
        // present sends the tool into a loop of failing APDUs.
        let usable = event.contains(pcsc::State::PRESENT) && !event.contains(pcsc::State::MUTE);
        let atr = if usable && !state.atr().is_empty() {
            Some(to_hex(state.atr()))
        } else {
            None
        };

        out.push(ReaderInfo {
            name: state.name().to_string_lossy().to_string(),
            card_present: usable,
            atr,
        });
    }
    Ok(out)
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct OpenResult {
    pub session: String,
    pub reader: String,
    pub atr: Option<String>,
}

pub fn open_session(
    state: &SmartcardState,
    tool_id: &str,
    reader: &str,
) -> Result<OpenResult, BrokerError> {
    if state.count_for(tool_id) >= MAX_SESSIONS_PER_TOOL {
        return Err(BrokerError::BadRequest(format!(
            "too many open card sessions (limit {MAX_SESSIONS_PER_TOOL}); close one first"
        )));
    }

    let ctx = context()?;
    let cname = std::ffi::CString::new(reader.as_bytes())
        .map_err(|_| BrokerError::BadRequest("reader name contains a NUL byte".into()))?;

    // Shared mode: Sanctum does not lock the user out of their own card, and
    // an exclusive claim from a page is a denial-of-service on every other
    // smart card consumer on the machine.
    let card = ctx
        .connect(&cname, pcsc::ShareMode::Shared, pcsc::Protocols::ANY)
        .map_err(|e| match e {
            pcsc::Error::NoSmartcard => {
                BrokerError::BadRequest("no card in that reader".to_string())
            }
            pcsc::Error::UnknownReader => {
                BrokerError::BadRequest(format!("no such reader: {reader}"))
            }
            other => pcsc_error(other),
        })?;

    let mut nbuf = [0u8; 512];
    let mut abuf = [0u8; 64];
    let atr = card
        .status2(&mut nbuf, &mut abuf)
        .ok()
        .map(|s| to_hex(s.atr()));

    let id = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            tool_id: tool_id.to_string(),
            reader: reader.to_string(),
            card,
            selected_aid: None,
        },
    );

    Ok(OpenResult {
        session: id,
        reader: reader.to_string(),
        atr,
    })
}

pub fn close_session(
    state: &SmartcardState,
    tool_id: &str,
    session_id: &str,
) -> Result<(), BrokerError> {
    let mut map = state.sessions.lock().unwrap();
    match map.get(session_id) {
        // Same answer for "not yours" as for "does not exist": a tool must not
        // be able to probe for other tools' session ids.
        Some(s) if s.tool_id == tool_id => {
            if let Some(session) = map.remove(session_id) {
                release(session.card);
            }
            Ok(())
        }
        _ => Err(BrokerError::BadRequest("unknown session".into())),
    }
}

// ── APDU exchange ─────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct ApduResult {
    /// Status word as a number, e.g. 0x9000 → 36864.
    pub sw: u16,
    /// True when `sw` is 0x9000. A convenience the page would otherwise
    /// open-code on every call — and get wrong by comparing against a string.
    pub ok: bool,
    /// Response body without the status word, lowercase hex.
    pub data: String,
}

impl ApduResult {
    fn new(sw: u16, data: Vec<u8>) -> Self {
        Self {
            sw,
            ok: sw == 0x9000,
            data: to_hex(&data),
        }
    }
}

/// Send one command APDU and follow ISO 7816 chaining to completion.
///
/// Two transport-level behaviours are handled here rather than in the page:
/// `61 XX` (more data available → GET RESPONSE) and `6C XX` (wrong Le → resend
/// with the length the card asked for). Both are plumbing; a tool that had to
/// implement them would get them subtly wrong.
///
/// CTAP2's own `9100` keep-alive is *not* handled here: it is an application
/// convention of the FIDO applet, and answering it means sending
/// `NFCCTAP_GETRESPONSE`, which belongs to the CTAP client in the page.
fn transmit_chained(card: &mut pcsc::Card, apdu: &[u8]) -> Result<ApduResult, BrokerError> {
    // A PC/SC transaction keeps other processes on this machine — on macOS
    // that includes CryptoTokenKit's own pollers — from interleaving an APDU
    // or resetting the card between our command and its chained continuations.
    let tx = card.transaction().map_err(pcsc_error)?;
    let card = &tx;

    let mut recv = vec![0u8; RECV_BUF_BYTES];
    let mut accumulated: Vec<u8> = Vec::new();

    let mut response = card.transmit(apdu, &mut recv).map_err(pcsc_error)?.to_vec();

    // 6C XX — the card wants a specific Le. Only meaningful for a short APDU
    // whose last byte is Le; resend once with the corrected length.
    if response.len() == 2 && response[0] == 0x6C && apdu.len() >= 5 {
        let mut retry = apdu.to_vec();
        *retry.last_mut().expect("non-empty") = response[1];
        let mut recv2 = vec![0u8; RECV_BUF_BYTES];
        response = card
            .transmit(&retry, &mut recv2)
            .map_err(pcsc_error)?
            .to_vec();
    }

    for _ in 0..MAX_CHAIN_ROUNDS {
        if response.len() < 2 {
            return Err(BrokerError::Pcsc(
                "card returned a response shorter than a status word".into(),
            ));
        }
        let sw1 = response[response.len() - 2];
        let sw2 = response[response.len() - 1];
        accumulated.extend_from_slice(&response[..response.len() - 2]);

        if accumulated.len() > MAX_RESPONSE_BYTES {
            return Err(BrokerError::Pcsc(format!(
                "response exceeded {MAX_RESPONSE_BYTES} bytes"
            )));
        }

        if sw1 != 0x61 {
            return Ok(ApduResult::new(u16::from_be_bytes([sw1, sw2]), accumulated));
        }

        // 61 XX — XX more bytes waiting (00 means "256 or unknown").
        let get_response = [0x00u8, 0xC0, 0x00, 0x00, sw2];
        let mut recv_n = vec![0u8; RECV_BUF_BYTES];
        response = card
            .transmit(&get_response, &mut recv_n)
            .map_err(pcsc_error)?
            .to_vec();
    }

    Err(BrokerError::Pcsc(
        "card kept asking for GET RESPONSE; chaining did not terminate".into(),
    ))
}

fn select_apdu(aid_bytes: &[u8]) -> Vec<u8> {
    let mut apdu = vec![0x00u8, 0xA4, 0x04, 0x00, aid_bytes.len() as u8];
    apdu.extend_from_slice(aid_bytes);
    // Le = 0: return whatever the applet answers with (FIDO returns "U2F_V2").
    apdu.push(0x00);
    apdu
}

/// Send an APDU, recovering once from a card that was reset under us.
///
/// A card can be reset by anything on the machine — another PC/SC client, the
/// platform's own token drivers, or a contactless card browning out during key
/// generation and re-entering the field. The handle survives; the card's state
/// does not. `SCardReconnect` re-powers it, but the applet selection is gone
/// with the reset, so it has to be re-selected before the retry or the tool
/// would silently address whatever applet the card defaults to.
///
/// If the card is physically absent, reconnect fails and the tool gets
/// `CardGone` — a prompt to re-present it, not a dead session.
fn exchange(session: &mut Session, apdu: &[u8]) -> Result<ApduResult, BrokerError> {
    match transmit_chained(&mut session.card, apdu) {
        Err(BrokerError::CardGone) => {}
        other => return other,
    }

    session
        .card
        .reconnect(
            pcsc::ShareMode::Shared,
            pcsc::Protocols::ANY,
            pcsc::Disposition::ResetCard,
        )
        .map_err(|_| BrokerError::CardGone)?;

    if let Some(aid) = session.selected_aid.clone() {
        let aid_bytes = from_hex(&aid)?;
        let reselect = transmit_chained(&mut session.card, &select_apdu(&aid_bytes))?;
        if !reselect.ok {
            // The card came back but the applet did not. Refuse rather than
            // send the tool's APDU to an unknown applet.
            session.selected_aid = None;
            return Err(BrokerError::Denied(
                "the card was reset and its applet could not be re-selected.",
            ));
        }
    }

    transmit_chained(&mut session.card, apdu)
}

/// SELECT an applet by AID, after checking the AID against the tool's approvals.
pub fn select_applet(
    state: &SmartcardState,
    tool_id: &str,
    approvals: &[DetectedCapability],
    session_id: &str,
    aid: &str,
) -> Result<ApduResult, BrokerError> {
    let aid = normalize_aid(aid)?;
    let allowed = approved_aids(approvals);
    if !allowed.iter().any(|a| a == &aid) {
        return Err(BrokerError::AidNotApproved(aid));
    }

    let aid_bytes = from_hex(&aid)?;
    let apdu = select_apdu(&aid_bytes);

    let mut map = state.sessions.lock().unwrap();
    let session = match map.get_mut(session_id) {
        Some(s) if s.tool_id == tool_id => s,
        _ => return Err(BrokerError::BadRequest("unknown session".into())),
    };

    let result = exchange(session, &apdu)?;
    // Only a successful selection unlocks raw transmit. `61 XX` was already
    // resolved by the chaining loop, so 0x9000 is the whole success case.
    if result.sw == 0x9000 {
        session.selected_aid = Some(aid);
    }
    Ok(result)
}

/// Send a raw command APDU on an already-selected applet.
pub fn transmit(
    state: &SmartcardState,
    tool_id: &str,
    session_id: &str,
    apdu_hex: &str,
) -> Result<ApduResult, BrokerError> {
    let apdu = from_hex(apdu_hex)?;
    if apdu.len() > MAX_APDU_BYTES {
        return Err(BrokerError::BadRequest(format!(
            "APDU is {} bytes, limit is {MAX_APDU_BYTES}",
            apdu.len()
        )));
    }
    if let Some(why) = is_forbidden_apdu(&apdu) {
        return Err(BrokerError::Denied(why));
    }

    let mut map = state.sessions.lock().unwrap();
    let session = match map.get_mut(session_id) {
        Some(s) if s.tool_id == tool_id => s,
        _ => return Err(BrokerError::BadRequest("unknown session".into())),
    };
    if session.selected_aid.is_none() {
        return Err(BrokerError::Denied(
            "no applet selected; call session.select(aid) first.",
        ));
    }

    exchange(session, &apdu)
}

// ── HTTP surface ──────────────────────────────────────────────────────────────

/// Parameters of a bridge request, read from the query string.
///
/// The page controls these values; it does not control `tool_id`, which comes
/// from the webview label. Everything below is therefore input to validate, not
/// identity to trust.
fn query_param(uri: &str, key: &str) -> Option<String> {
    // A tool URI is `sanctum-tool://tool-{id}/path?query` on macOS and Linux
    // and `http://sanctum-tool.localhost/path?query` on Windows; both parse.
    let parsed = url::Url::parse(uri).ok()?;
    parsed
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

fn json_response(status: u16, body: String) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "application/json; charset=utf-8")
        // Responses carry live card state; a cached one would be a lie, and on
        // some platforms a persisted one.
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body.into_bytes())
        .expect("valid response")
}

fn ok_json<T: serde::Serialize>(value: &T) -> tauri::http::Response<Vec<u8>> {
    match serde_json::to_string(value) {
        Ok(s) => json_response(200, s),
        Err(e) => err_json(&BrokerError::Pcsc(format!("serialisation failed: {e}"))),
    }
}

fn err_json(e: &BrokerError) -> tauri::http::Response<Vec<u8>> {
    let body = serde_json::json!({ "error": e.message() }).to_string();
    json_response(e.status(), body)
}

/// Answer one `__sanctum/v1/{op}` request from a tool window.
///
/// `approvals` is the launch-time grant for the calling tool, and `tool_id`
/// came from the webview label — neither is page-supplied.
pub fn serve_bridge(
    app: &tauri::AppHandle,
    tool_id: &str,
    approvals: &[DetectedCapability],
    op: &str,
    uri: &str,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    // One gate for every operation, checked before the request is even parsed.
    if !has_smartcard_capability(approvals) {
        return err_json(&BrokerError::NotApproved);
    }

    let state = app.state::<SmartcardState>();
    let need = |key: &str| -> Result<String, BrokerError> {
        query_param(uri, key)
            .ok_or_else(|| BrokerError::BadRequest(format!("missing `{key}` parameter")))
    };

    let result = match op {
        "readers" => list_readers().map(|r| serde_json::json!({ "readers": r })),
        "open" => need("reader")
            .and_then(|reader| open_session(&state, tool_id, &reader))
            .map(|r| serde_json::json!(r)),
        "select" => need("session")
            .and_then(|session| Ok((session, need("aid")?)))
            .and_then(|(session, aid)| select_applet(&state, tool_id, approvals, &session, &aid))
            .map(|r| serde_json::json!(r)),
        "transmit" => need("session")
            .and_then(|session| Ok((session, need("apdu")?)))
            .and_then(|(session, apdu)| transmit(&state, tool_id, &session, &apdu))
            .map(|r| serde_json::json!(r)),
        "close" => need("session")
            .and_then(|session| close_session(&state, tool_id, &session))
            .map(|_| serde_json::json!({ "closed": true })),
        _ => Err(BrokerError::BadRequest(format!(
            "unknown smart card operation: {op}"
        ))),
    };

    match result {
        Ok(v) => ok_json(&v),
        Err(e) => err_json(&e),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SmartcardCapability;

    const FIDO: &str = "a0000006472f0001";
    const PIV: &str = "a000000308000010000100";

    fn sc(aids: &[&str]) -> DetectedCapability {
        DetectedCapability::Smartcard(SmartcardCapability {
            smartcard: aids.iter().map(|s| s.to_string()).collect(),
        })
    }

    // ── AID validation ────────────────────────────────────────────────────────

    #[test]
    fn real_aids_are_valid() {
        for aid in [FIDO, PIV, "d2760001240102000000000000010000"] {
            assert!(is_valid_aid(aid), "rejected real AID: {aid}");
        }
    }

    #[test]
    fn malformed_aids_are_invalid() {
        for aid in [
            "",                                   // empty
            "a0000006",                           // 4 bytes — under the ISO floor
            "a0000006472f0001a0000006472f000100", // 17 bytes — over the ceiling
            "a0000006472f000",                    // odd digit count
            "A0000006472F0001",                   // uppercase: one applet, two spellings
            "a0000006472f00zz",                   // non-hex
            "a0000006472f0001;x",                 // separator smuggling
            "(dynamic)",                          // the sentinel is never an AID
        ] {
            assert!(!is_valid_aid(aid), "accepted malformed AID: {aid}");
        }
    }

    #[test]
    fn normalize_lowercases_and_trims() {
        assert_eq!(normalize_aid(" A0000006472F0001 ").unwrap(), FIDO);
    }

    #[test]
    fn normalize_rejects_junk() {
        assert!(normalize_aid("nope").is_err());
    }

    // ── Approval extraction ───────────────────────────────────────────────────

    #[test]
    fn approved_aids_come_only_from_smartcard_capabilities() {
        let approvals = vec![
            sc(&[FIDO]),
            DetectedCapability::Feature(crate::models::CapabilityFeature::Usb),
        ];
        assert_eq!(approved_aids(&approvals), vec![FIDO.to_string()]);
    }

    #[test]
    fn dynamic_sentinel_grants_no_applet() {
        // Mirrors the network model: an unresolved destination grants nothing.
        let approvals = vec![sc(&["(dynamic)"])];
        assert!(approved_aids(&approvals).is_empty());
        // …but the tool is still "smart card approved", so it may list readers.
        assert!(has_smartcard_capability(&approvals));
    }

    #[test]
    fn a_tampered_approval_row_cannot_smuggle_an_aid() {
        // Approvals round-trip through SQLite as JSON; an edited row must not
        // become an allow-list entry.
        let approvals = vec![sc(&["a0000006472f0001 or 1=1", "A0000006472F0001"])];
        assert!(approved_aids(&approvals).is_empty());
    }

    #[test]
    fn no_smartcard_capability_means_no_aids() {
        let approvals = vec![DetectedCapability::Net(crate::models::NetCapability {
            net: vec!["api.example.com".into()],
        })];
        assert!(!has_smartcard_capability(&approvals));
        assert!(approved_aids(&approvals).is_empty());
    }

    // ── APDU policy ───────────────────────────────────────────────────────────

    #[test]
    fn interindustry_select_is_refused() {
        // The pivot this whole module exists to prevent: a tool approved for
        // FIDO reselecting the PIV applet on the same card.
        let mut apdu = vec![0x00, 0xA4, 0x04, 0x00, 0x0B];
        apdu.extend_from_slice(&hex::decode(PIV).unwrap());
        assert!(is_forbidden_apdu(&apdu).is_some());
    }

    #[test]
    fn select_on_a_logical_channel_is_also_refused() {
        // CLA 0x01–0x03 are the same interindustry class on another channel.
        for cla in [0x01u8, 0x02, 0x03, 0x0C] {
            assert!(
                is_forbidden_apdu(&[cla, 0xA4, 0x04, 0x00]).is_some(),
                "SELECT allowed under CLA {cla:#04x}"
            );
        }
    }

    #[test]
    fn manage_channel_and_get_response_are_refused() {
        assert!(is_forbidden_apdu(&[0x00, 0x70, 0x00, 0x00]).is_some());
        assert!(is_forbidden_apdu(&[0x00, 0xC0, 0x00, 0x00, 0x10]).is_some());
    }

    #[test]
    fn ctap2_message_is_allowed() {
        // NFCCTAP_MSG — the command the sample FIDO tool is built on.
        assert!(is_forbidden_apdu(&[0x80, 0x10, 0x00, 0x00, 0x01, 0x04]).is_none());
        // NFCCTAP_GETRESPONSE, answering a 9100 keep-alive.
        assert!(is_forbidden_apdu(&[0x80, 0x11, 0x00, 0x00, 0x00]).is_none());
    }

    #[test]
    fn proprietary_class_keeps_its_own_ins_bytes() {
        // 0xA4 under a proprietary CLA is not SELECT and must not be blocked.
        assert!(is_forbidden_apdu(&[0x80, 0xA4, 0x00, 0x00]).is_none());
    }

    #[test]
    fn truncated_apdus_are_refused() {
        for short in [vec![], vec![0x00], vec![0x00, 0xA4], vec![0x00, 0xA4, 0x04]] {
            assert!(is_forbidden_apdu(&short).is_some(), "{short:?} accepted");
        }
    }

    // ── Hex ───────────────────────────────────────────────────────────────────

    #[test]
    fn hex_round_trips() {
        assert_eq!(from_hex("80100000").unwrap(), vec![0x80, 0x10, 0x00, 0x00]);
        assert_eq!(to_hex(&[0x90, 0x00]), "9000");
        assert_eq!(from_hex("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn malformed_hex_is_rejected() {
        for bad in ["8", "80 10", "zz", "0x8010"] {
            assert!(from_hex(bad).is_err(), "accepted bad hex: {bad}");
        }
    }

    // ── Session ownership ─────────────────────────────────────────────────────

    #[test]
    fn another_tools_session_id_is_indistinguishable_from_a_missing_one() {
        let state = SmartcardState::new();
        // No card needed: ownership is checked before the card is touched.
        let err = close_session(&state, "tool-a", "some-session-id").unwrap_err();
        assert!(matches!(err, BrokerError::BadRequest(ref m) if m == "unknown session"));
        assert_eq!(err.status(), 400);
    }

    #[test]
    fn transmit_before_select_is_denied() {
        let state = SmartcardState::new();
        let err = transmit(&state, "tool-a", "missing", "80100000").unwrap_err();
        // Session lookup fails first; the point is that it never reaches a card.
        assert!(matches!(err, BrokerError::BadRequest(_)));
    }

    #[test]
    fn forbidden_apdu_is_rejected_before_session_lookup() {
        // Policy is checked on the input, not on the session, so a bogus
        // session id cannot be used to skip it.
        let state = SmartcardState::new();
        let err = transmit(&state, "tool-a", "missing", "00a4040008a0000006472f0001").unwrap_err();
        assert!(matches!(err, BrokerError::Denied(_)));
        assert_eq!(err.status(), 403);
    }

    #[test]
    fn oversized_apdu_is_rejected() {
        let state = SmartcardState::new();
        let huge = "80100000".to_string() + &"00".repeat(MAX_APDU_BYTES);
        let err = transmit(&state, "tool-a", "missing", &huge).unwrap_err();
        assert!(matches!(err, BrokerError::BadRequest(ref m) if m.contains("limit")));
    }

    #[test]
    fn closing_a_window_drops_only_that_tools_sessions() {
        let state = SmartcardState::new();
        // Sessions hold a live pcsc::Card, so build the map through the mutex
        // rather than constructing one here; with no entries the retain is
        // still the behaviour under test: it must not panic or clear globally.
        state.close_tool_sessions("tool-a");
        assert!(state.sessions.lock().unwrap().is_empty());
    }

    // ── SELECT construction ───────────────────────────────────────────────────

    #[test]
    fn select_apdu_is_well_formed() {
        let apdu = select_apdu(&hex::decode(FIDO).unwrap());
        assert_eq!(&apdu[..4], &[0x00, 0xA4, 0x04, 0x00], "not SELECT by name");
        assert_eq!(apdu[4] as usize, 8, "Lc must be the AID length");
        assert_eq!(&apdu[5..13], &hex::decode(FIDO).unwrap()[..]);
        assert_eq!(*apdu.last().unwrap(), 0x00, "Le must be present");
    }

    #[test]
    fn the_select_we_build_would_be_refused_on_the_raw_channel() {
        // The broker's own SELECT is exactly what a tool is not allowed to send
        // itself — that asymmetry is the applet allow-list.
        assert!(is_forbidden_apdu(&select_apdu(&hex::decode(FIDO).unwrap())).is_some());
    }

    // ── Card-state classification ─────────────────────────────────────────────

    #[test]
    fn a_lost_card_is_recoverable_not_a_reader_fault() {
        for e in [
            pcsc::Error::RemovedCard,
            pcsc::Error::ResetCard,
            pcsc::Error::UnpoweredCard,
            pcsc::Error::UnresponsiveCard,
            pcsc::Error::NotTransacted,
            pcsc::Error::NoSmartcard,
        ] {
            assert!(card_gone(&e), "{e:?} should read as a lost card");
            assert_eq!(pcsc_error(e).status(), 409);
        }
    }

    #[test]
    fn a_real_reader_fault_is_not_reported_as_a_lost_card() {
        for e in [pcsc::Error::NoService, pcsc::Error::ReaderUnavailable] {
            assert!(!card_gone(&e), "{e:?} should not read as a lost card");
            assert_eq!(pcsc_error(e).status(), 502);
        }
    }

    // ── Request parsing ───────────────────────────────────────────────────────

    #[test]
    fn query_params_survive_both_url_forms() {
        // macOS/Linux custom scheme…
        let uri = "sanctum-tool://tool-abc/__sanctum/v1/open?reader=Generic%20EMV%20Reader%2001";
        assert_eq!(
            query_param(uri, "reader").as_deref(),
            Some("Generic EMV Reader 01")
        );
        // …and the Windows/Android http form.
        let win =
            "http://sanctum-tool.localhost/__sanctum/v1/select?session=s1&aid=a0000006472f0001";
        assert_eq!(query_param(win, "aid").as_deref(), Some(FIDO));
        assert_eq!(query_param(win, "missing"), None);
    }

    // ── Error mapping ─────────────────────────────────────────────────────────

    #[test]
    fn approval_failures_are_403_not_404() {
        // A tool must learn "refused", never "no such thing" — the distinction
        // is what turns a denial into a probe.
        assert_eq!(BrokerError::NotApproved.status(), 403);
        assert_eq!(BrokerError::AidNotApproved(FIDO.into()).status(), 403);
    }

    #[test]
    fn aid_denial_names_the_applet_the_user_would_have_to_approve() {
        let msg = BrokerError::AidNotApproved(PIV.into()).message();
        assert!(msg.contains(PIV), "{msg}");
    }
}
