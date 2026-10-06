//! `POST /v1/relay`: a settlement sealed to the gateway by a payer who is offline and posted by a
//! phone that is not, which learns neither the payer nor the amount. The payer reads the answer
//! the gateway seals back to the key of the request (RFC 9458 section 4.4).
use crate::{
    claims,
    hpke::{self, OpenError},
    jobs::{JobState, SettlementJob},
    limits::{RELAY_PREFIX, RequestLimits},
    onboard::local_now,
    server::{Error, Gateway},
    settlements::{
        self, MAX_CHAIN_SPENDS, Planned, Problem, SettlementRequest, inspect_settlement,
    },
};
use axum::{
    body::Bytes,
    extract::{Request, State},
    http::{StatusCode, header::CONTENT_TYPE},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use serde_json::json;
use sha2_v11::Sha256;
use std::{net::IpAddr, num::NonZeroU32, sync::Arc, time::Duration};
use tracing::{info, warn};

/// `keyId u8 ‖ enc 32 ‖ ciphertext`, the ciphertext being a bucket and a 16-byte tag.
pub const MAX_RELAY_BYTES: usize = 8_241;
/// Every sealed answer carries a body of this length.
pub const RESPONSE_PAD: usize = 256;
pub const RELAY_AAD: &[u8] = b"buckspay/relay/v1";
pub const EXPORT_LABEL: &[u8] = b"buckspay relay response";
/// The sizes of the inner message: it reveals its bucket and nothing finer.
const BUCKETS: [usize; 4] = [1024, 2048, 4096, 8192];
const HEADER: usize = 1 + 32;
const TAG: usize = 16;
/// Seconds a relayer is told to wait before it hands a blob over again.
const RETRY_AFTER: u64 = 600;
const RETRY_AFTER_UPSTREAM: u64 = 60;

/// The message the payer sealed: the signed issue and the signed spends of one note.
pub struct Inner {
    pub issue: Vec<u8>,
    pub spends: Vec<Vec<u8>>,
}

fn invalid(message: &'static str) -> Problem {
    Problem::Invalid(message)
}

fn take<'a>(plain: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], Problem> {
    let end = at
        .checked_add(len)
        .filter(|end| *end <= plain.len())
        .ok_or(invalid("the relayed message is cut short"))?;
    let part = &plain[*at..end];
    *at = end;
    Ok(part)
}

fn length(plain: &[u8], at: &mut usize) -> Result<usize, Problem> {
    let bytes = take(plain, at, 2)?;
    Ok(usize::from(u16::from_be_bytes([bytes[0], bytes[1]])))
}

/// `version 1 ‖ kind 1 ‖ issueLen u16 ‖ issue ‖ n u8 ‖ (len u16 ‖ spend) × n`, then zeros up to a
/// bucket size.
pub fn parse_inner(plain: &[u8]) -> Result<Inner, Problem> {
    if !BUCKETS.contains(&plain.len()) {
        return Err(invalid("the relayed message is not a bucket size"));
    }
    let mut at = 0;
    if take(plain, &mut at, 2)? != [1, 1] {
        return Err(invalid("not a relayed settlement"));
    }
    let issue_len = length(plain, &mut at)?;
    let issue = take(plain, &mut at, issue_len)?.to_vec();
    let count = usize::from(take(plain, &mut at, 1)?[0]);
    if !(1..=MAX_CHAIN_SPENDS).contains(&count) {
        return Err(invalid(
            "a relayed settlement carries one to sixteen spends",
        ));
    }
    let mut spends = Vec::with_capacity(count);
    for _ in 0..count {
        let len = length(plain, &mut at)?;
        spends.push(take(plain, &mut at, len)?.to_vec());
    }
    if plain[at..].iter().any(|byte| *byte != 0) {
        return Err(invalid("the padding of a relayed message is not zeros"));
    }
    Ok(Inner { issue, spends })
}

#[derive(Debug, PartialEq)]
pub enum FinalReason {
    Invalid,
    Window,
    Conflict,
    Lock,
}

/// What the payer is told. `Refused` is only for what `settlements::ended` ends for good: any
/// other refusal is `Retry`, which never releases the payer's reservation.
#[derive(Debug, PartialEq)]
pub enum Answer {
    Submitted,
    Settled { signature: String },
    Duplicate,
    Retry { retry_after: u64 },
    Refused { reason: FinalReason },
}

impl Answer {
    /// The JSON of the answer, zero-padded to `RESPONSE_PAD`.
    pub fn padded_json(&self) -> Vec<u8> {
        let body = match self {
            Answer::Submitted => json!({ "status": "submitted" }),
            Answer::Settled { signature } => json!({ "status": "settled", "signature": signature }),
            Answer::Duplicate => json!({ "status": "duplicate" }),
            Answer::Retry { retry_after } => {
                json!({ "status": "retry", "retryAfter": retry_after })
            }
            Answer::Refused { reason } => json!({
                "status": "refused",
                "reason": match reason {
                    FinalReason::Invalid => "invalid",
                    FinalReason::Window => "window",
                    FinalReason::Conflict => "conflict",
                    FinalReason::Lock => "lock",
                },
            }),
        };
        let mut bytes = serde_json::to_vec(&body).expect("an answer is JSON");
        bytes.resize(RESPONSE_PAD, 0);
        bytes
    }
}

/// The only mapping from what a settlement came to, to what the payer is told.
pub fn answer_for(outcome: &Result<Planned, Error>) -> Answer {
    match outcome {
        Ok(Planned::Settled) | Err(Error::Busy) => Answer::Duplicate,
        Ok(Planned::Send(_)) => Answer::Submitted,
        Err(error) if settlements::ended(error).is_some() => Answer::Refused {
            reason: match error {
                Error::Settlement(Problem::Window(_)) => FinalReason::Window,
                Error::Settlement(Problem::Conflict(_) | Problem::Lock("insufficient_backing")) => {
                    FinalReason::Conflict
                }
                Error::Settlement(Problem::Lock(_)) => FinalReason::Lock,
                _ => FinalReason::Invalid,
            },
        },
        Err(Error::Settlement(Problem::Limits(_, retry_after))) => Answer::Retry {
            retry_after: retry_after.map_or(RETRY_AFTER, u64::from),
        },
        Err(Error::Upstream) => Answer::Retry {
            retry_after: RETRY_AFTER_UPSTREAM,
        },
        Err(_) => Answer::Retry {
            retry_after: RETRY_AFTER,
        },
    }
}

fn response_cipher(
    exporter: &[u8; 32],
    enc: &[u8; 32],
    nonce: &[u8; 32],
) -> (ChaCha20Poly1305, Nonce) {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(enc);
    salt[32..].copy_from_slice(nonce);
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), exporter);
    let mut key = [0u8; 32];
    let mut iv = [0u8; 12];
    hkdf.expand(b"key", &mut key)
        .expect("32 bytes are a valid length");
    hkdf.expand(b"nonce", &mut iv)
        .expect("12 bytes are a valid length");
    (ChaCha20Poly1305::new(&Key::from(key)), Nonce::from(iv))
}

/// `responseNonce ‖ ChaCha20-Poly1305(body)`, keyed from the HPKE exporter secret and bound to the
/// request's `enc`: only the sender of the request can open it.
pub fn seal_response(exporter: &[u8; 32], enc: &[u8; 32], body: &[u8], nonce: [u8; 32]) -> Vec<u8> {
    let (cipher, iv) = response_cipher(exporter, enc, &nonce);
    let sealed = cipher
        .encrypt(
            &iv,
            Payload {
                msg: body,
                aad: b"",
            },
        )
        .expect("a response fits an AEAD");
    [nonce.as_slice(), &sealed].concat()
}

/// What bounds relaying, apart from the settlement limits every relayed note meets: requests to
/// `/v1/relay` count in the relay's own buckets, the refused ones too, so junk posted through a
/// relayer costs it none of its own direct requests.
pub struct Relay {
    /// The longest random wait, in seconds, before a relayed settlement is sent.
    pub delay_max_secs: u32,
    per_prefix: RequestLimits,
    wide: RequestLimits,
}

impl Relay {
    /// The default request limits and a random wait of up to `delay_max_secs`.
    pub fn with_delay(delay_max_secs: u32) -> Self {
        Self {
            delay_max_secs,
            ..Self::default()
        }
    }

    pub fn new(
        delay_max_secs: u32,
        per_prefix_per_minute: NonZeroU32,
        wide_per_minute: NonZeroU32,
    ) -> Self {
        Self {
            delay_max_secs,
            per_prefix: RequestLimits::new(per_prefix_per_minute),
            wide: RequestLimits::new(wide_per_minute),
        }
    }
}

impl Default for Relay {
    fn default() -> Self {
        Self::new(
            30,
            NonZeroU32::new(60).unwrap(),
            NonZeroU32::new(600).unwrap(),
        )
    }
}

pub(crate) async fn limit(state: &Gateway, ip: IpAddr, request: Request, next: Next) -> Response {
    let relay = &state.relay;
    if relay.per_prefix.check(ip.into()).is_err() || relay.wide.check(RELAY_PREFIX).is_err() {
        return Error::RateLimited.into_response();
    }
    next.run(request).await
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system has a source of randomness");
    bytes
}

/// Sends the job once its wait is over, unless the janitor or another copy has.
pub(crate) fn drive_later(state: Arc<Gateway>, job: SettlementJob) {
    tokio::spawn(async move {
        if let Some(at) = job.not_before {
            let wait = at.saturating_sub(local_now());
            tokio::time::sleep(Duration::from_secs(u64::from(wait))).await;
        }
        settlements::resume(&state, &job).await;
    });
}

/// After a restart: the relayed jobs still waiting are driven again without waiting for the
/// janitor.
pub fn resume_pending(state: &Arc<Gateway>) {
    for job in state.jobs.pending() {
        if job.not_before.is_some() {
            drive_later(Arc::clone(state), job);
        }
    }
}

fn sealed(exporter: &[u8; 32], enc: &[u8; 32], answer: &Answer) -> Response {
    (
        StatusCode::OK,
        [(CONTENT_TYPE, "application/octet-stream")],
        seal_response(exporter, enc, &answer.padded_json(), random_bytes()),
    )
        .into_response()
}

pub(crate) async fn relay(State(state): State<Arc<Gateway>>, body: Bytes) -> Response {
    if body.len() > MAX_RELAY_BYTES
        || body.len() < HEADER + TAG
        || !BUCKETS.contains(&(body.len() - HEADER - TAG))
    {
        return Error::BadRequest("not a relayed settlement").into_response();
    }
    let (key_id, rest) = (body[0], &body[1..]);
    let (enc, ciphertext) = rest.split_at(32);
    let info = hpke::info("relay", &state.settings.genesis_hash);
    let (plain, exporter) = match state.hpke.open_with_export_at(
        u64::from(local_now()),
        key_id,
        enc,
        ciphertext,
        &info,
        RELAY_AAD,
        EXPORT_LABEL,
    ) {
        Ok(opened) => opened,
        Err(OpenError::UnknownKey) => return Error::BadRequest("unknown key").into_response(),
        Err(OpenError::Refused) => {
            return Error::BadRequest("the message does not open").into_response();
        }
    };
    let enc: [u8; 32] = enc.try_into().expect("split at 32");
    let inner = match parse_inner(&plain) {
        Ok(inner) => inner,
        Err(problem) => return problem.into_response(),
    };
    let request = SettlementRequest {
        issue: hex::encode(&inner.issue),
        spends: inner.spends.iter().map(hex::encode).collect(),
    };
    sealed(&exporter, &enc, &settle(&state, request).await)
}

/// Inspects the settlement, checks the limits it would meet, writes the job down and answers
/// `submitted` only then.
async fn settle(state: &Arc<Gateway>, request: SettlementRequest) -> Answer {
    let key = settlements::job_key(&request);
    let job = match inspect_settlement(state, RELAY_PREFIX, &request).await {
        Ok(Planned::Send(job)) => *job,
        other => {
            if let Err(Error::Settlement(
                Problem::Conflict(_) | Problem::Lock("insufficient_backing"),
            )) = &other
            {
                claims::file_in_background(Arc::clone(state), request);
            }
            return answer_for(&other);
        }
    };
    if state.jobs.get(&key).is_some() {
        return Answer::Duplicate;
    }
    let now = job.request.now;
    if let Err(refusal) = state
        .settlements
        .reserve_priced(job.request.clone(), job.priced)
    {
        return answer_for(&Err(settlements::limits(state, refusal, now)));
    }
    let row =
        SettlementJob {
            key,
            issue: request.issue,
            spends: request.spends,
            prefix: RELAY_PREFIX,
            created_at: now,
            deadline: job.deadline,
            batches_done: 0,
            state: JobState::Pending,
            last_signature: None,
            last_valid_block_height: None,
            not_before: Some(local_now().saturating_add(
                u32::from_le_bytes(random_bytes()) % (state.relay.delay_max_secs + 1),
            )),
        };
    match state.jobs.begin(row.clone()) {
        Ok(true) => {
            info!("a relayed settlement was accepted");
            drive_later(Arc::clone(state), row);
            Answer::Submitted
        }
        Ok(false) => Answer::Duplicate,
        Err(_) => {
            warn!("a relayed job could not be written; nothing was sent");
            answer_for(&Err(Error::Upstream))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner(issue: &[u8], spends: &[&[u8]], bucket: usize) -> Vec<u8> {
        let mut v = vec![1u8, 1];
        v.extend((issue.len() as u16).to_be_bytes());
        v.extend(issue);
        v.push(spends.len() as u8);
        for s in spends {
            v.extend((s.len() as u16).to_be_bytes());
            v.extend(*s);
        }
        v.resize(bucket, 0);
        v
    }

    fn open_response_for_test(
        exporter: &[u8; 32],
        enc: &[u8; 32],
        sealed: &[u8],
    ) -> Option<Vec<u8>> {
        let (nonce, ciphertext) = sealed.split_at_checked(32)?;
        let (cipher, iv) = response_cipher(exporter, enc, nonce.try_into().ok()?);
        cipher
            .decrypt(
                &iv,
                Payload {
                    msg: ciphertext,
                    aad: b"",
                },
            )
            .ok()
    }

    #[test]
    fn parses_an_inner_settlement_with_padding() {
        let p = parse_inner(&inner(&[7; 140], &[&[8; 150]], 1024)).unwrap();
        assert_eq!(p.issue, vec![7; 140]);
        assert_eq!(p.spends, vec![vec![8; 150]]);
    }

    #[test]
    fn refuses_nonzero_padding_unknown_kind_and_bad_counts() {
        let mut v = inner(&[7; 140], &[&[8; 150]], 1024);
        *v.last_mut().unwrap() = 1;
        assert!(parse_inner(&v).is_err());
        let mut k = inner(&[7; 140], &[&[8; 10]], 1024);
        k[1] = 2;
        assert!(parse_inner(&k).is_err());
        assert!(parse_inner(&inner(&[7; 140], &[&[8u8; 10] as &[u8]; 17], 8192)).is_err());
        assert!(parse_inner(&inner(&[7; 140], &[], 1024)).is_err());
        assert!(parse_inner(&inner(&[7; 140], &[&[8; 150]], 1000)).is_err());
    }

    #[test]
    fn every_answer_has_the_same_sealed_length() {
        let answers = [
            Answer::Submitted,
            Answer::Duplicate,
            Answer::Retry { retry_after: 600 },
            Answer::Settled {
                signature: "5".repeat(88),
            },
            Answer::Refused {
                reason: FinalReason::Conflict,
            },
        ];
        let lens: Vec<usize> = answers
            .iter()
            .map(|a| seal_response(&[3; 32], &[4; 32], &a.padded_json(), [5; 32]).len())
            .collect();
        assert!(lens.iter().all(|l| *l == lens[0]));
        assert_eq!(lens[0], 32 + RESPONSE_PAD + 16);
    }

    #[test]
    fn only_final_reasons_are_refused() {
        use crate::float::Refusal;
        let limits = |r| Error::Settlement(Problem::Limits(r, None));
        for error in [
            Error::Settlement(Problem::NoTokenAccount),
            Error::Settlement(Problem::Claim("claim")),
            limits(Refusal::PrefixBusy),
            limits(Refusal::PrefixSpentToday),
            limits(Refusal::KeySpentToday),
            limits(Refusal::DailyCap),
            limits(Refusal::FloatCap),
            limits(Refusal::Unwritable),
            Error::Upstream,
            Error::Failed,
            Error::Rejected,
            Error::Retry,
            Error::Settlement(Problem::Invalid(settlements::UNREADABLE)),
        ] {
            assert!(
                matches!(answer_for(&Err(error)), Answer::Retry { .. }),
                "non-final reasons are retried"
            );
        }
        assert!(matches!(answer_for(&Err(Error::Busy)), Answer::Duplicate));
        for problem in [
            Problem::Invalid("sig"),
            Problem::Window("late"),
            Problem::Conflict([0; 32]),
            Problem::Lock("wrong_lock"),
            Problem::Lock("insufficient_backing"),
        ] {
            let error = Error::Settlement(problem);
            assert!(settlements::ended(&error).is_some());
            assert!(matches!(answer_for(&Err(error)), Answer::Refused { .. }));
        }
    }

    #[test]
    fn a_sealed_response_opens_only_with_the_exporter_secret() {
        let (secret, enc, nonce) = ([3u8; 32], [4u8; 32], [5u8; 32]);
        let sealed = seal_response(&secret, &enc, br#"{"status":"submitted"}"#, nonce);
        assert_eq!(
            open_response_for_test(&secret, &enc, &sealed).unwrap(),
            br#"{"status":"submitted"}"#
        );
        assert!(open_response_for_test(&[9u8; 32], &enc, &sealed).is_none());
        assert!(open_response_for_test(&secret, &[9u8; 32], &sealed).is_none());
        let mut flipped = sealed.clone();
        flipped[40] ^= 1;
        assert!(open_response_for_test(&secret, &enc, &flipped).is_none());
    }

    #[test]
    fn prints_the_vectors_the_app_opens() {
        let cases: [(u8, Answer); 3] = [
            (1, Answer::Submitted),
            (2, Answer::Retry { retry_after: 600 }),
            (
                3,
                Answer::Settled {
                    signature: "5".repeat(88),
                },
            ),
        ];
        let hexed = |bytes: &[u8]| hex::encode(bytes);
        let vectors: Vec<_> = cases
            .iter()
            .map(|(seed, answer)| {
                let (secret, enc, nonce) = ([*seed; 32], [seed + 10; 32], [seed + 20; 32]);
                let padded = answer.padded_json();
                let end = padded.iter().rposition(|b| *b != 0).unwrap() + 1;
                json!({
                    "secret": hexed(&secret),
                    "enc": hexed(&enc),
                    "sealed": hexed(&seal_response(&secret, &enc, &padded, nonce)),
                    "body": String::from_utf8(padded[..end].to_vec()).unwrap(),
                })
            })
            .collect();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/vectors/relay-response.json"
        );
        let text = serde_json::to_string_pretty(&vectors).unwrap() + "\n";
        if std::env::var_os("WRITE_VECTORS").is_some() {
            std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
            std::fs::write(path, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
}
