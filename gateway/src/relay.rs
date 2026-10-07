//! `POST /v1/relay`: a settlement sealed to the gateway by a payer who is offline and posted by a
//! phone that is not, which learns neither the payer nor the amount. The payer reads the answer
//! the gateway seals back to the key of the request (RFC 9458 section 4.4).
use crate::{
    claims,
    hpke::{self, OpenError},
    jobs::{JobState, SettlementJob},
    limits::{RELAY_PREFIX, RequestLimits},
    onboard::{local_now, read},
    server::{Error, Gateway},
    settlements::{
        self, MAX_CHAIN_SPENDS, Planned, Problem, SettlementRequest, inspect_settlement,
        parse_issue,
    },
    words::{self, Binding, Outcome},
};
use axum::{
    body::Bytes,
    extract::{Path, Request, State},
    http::{StatusCode, header::CONTENT_TYPE},
    middleware::Next,
    response::{IntoResponse, Response},
};
use buckspay_client::accounts::Lock;
use buckspay_protocol::{
    Issue,
    hash::{domain, purpose},
    payword::{self, Commitment, WordProof},
    verify::verify_signature,
};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use serde_json::json;
use sha2::Digest;
use sha2_v11::Sha256;
use std::{net::IpAddr, num::NonZeroU32, sync::Arc, time::Duration};
use tracing::{info, warn};

/// `keyId u8 ‖ enc 32 ‖ ciphertext [‖ rk 32]`, the ciphertext being a bucket and a 16-byte tag.
pub const MAX_RELAY_BYTES: usize = 8_241 + RK_LEN;
/// The key a relayer asks its word to be sealed to, after the ciphertext.
const RK_LEN: usize = 32;
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

/// The message the payer sealed: the signed issue and the signed spends of one note, and the
/// delivery word it tips with.
pub struct Inner {
    pub issue: Vec<u8>,
    pub spends: Vec<Vec<u8>>,
    pub word: Option<WordPart>,
}

/// A delivery word as the payer wrote it: not yet checked against anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordPart {
    pub commitment: Vec<u8>,
    pub signature: [u8; 64],
    pub proof: Vec<u8>,
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
/// bucket size. Kind 2 adds `commitment 91 ‖ sig 64 ‖ wordLen u16 ‖ word proof` before the zeros:
/// a word part that is cut short or followed by anything but zeros is dropped, and the payment
/// settles as kind 1.
pub fn parse_inner(plain: &[u8]) -> Result<Inner, Problem> {
    if !BUCKETS.contains(&plain.len()) {
        return Err(invalid("the relayed message is not a bucket size"));
    }
    let mut at = 0;
    let kind = match take(plain, &mut at, 2)? {
        [1, kind @ (1 | 2)] => *kind,
        _ => return Err(invalid("not a relayed settlement")),
    };
    let issue_len = length(plain, &mut at)?;
    let issue = take(plain, &mut at, issue_len)?.to_vec();
    let count = usize::from(take(plain, &mut at, 1)?[0]);
    if count > MAX_CHAIN_SPENDS {
        return Err(invalid(
            "a relayed settlement carries at most sixteen spends",
        ));
    }
    let mut spends = Vec::with_capacity(count);
    for _ in 0..count {
        let len = length(plain, &mut at)?;
        spends.push(take(plain, &mut at, len)?.to_vec());
    }
    if kind == 2 {
        let word = word_part(plain, &mut at).filter(|_| plain[at..].iter().all(|byte| *byte == 0));
        return Ok(Inner {
            issue,
            spends,
            word,
        });
    }
    if plain[at..].iter().any(|byte| *byte != 0) {
        return Err(invalid("the padding of a relayed message is not zeros"));
    }
    Ok(Inner {
        issue,
        spends,
        word: None,
    })
}

fn word_part(plain: &[u8], at: &mut usize) -> Option<WordPart> {
    let commitment = take(plain, at, payword::COMMITMENT_LEN).ok()?.to_vec();
    let signature = take(plain, at, 64).ok()?.try_into().ok()?;
    let len = length(plain, at).ok()?;
    let proof = take(plain, at, len).ok()?.to_vec();
    Some(WordPart {
        commitment,
        signature,
        proof,
    })
}

/// A relayed body taken apart.
pub struct Body<'a> {
    pub key_id: u8,
    pub enc: [u8; 32],
    pub ciphertext: &'a [u8],
    pub rk: Option<[u8; RK_LEN]>,
    /// The SHA-256 of the blob without `rk`, hex: what the word is asked for by.
    pub id: String,
}

/// `keyId u8 ‖ enc 32 ‖ ciphertext`, then an optional `rk` of 32 bytes: the ciphertext is a bucket
/// and a tag, so the length says whether `rk` is there.
pub fn split_body(body: &[u8]) -> Result<Body<'_>, Error> {
    let fits = |len: usize| {
        (HEADER + TAG..=MAX_RELAY_BYTES).contains(&len) && BUCKETS.contains(&(len - HEADER - TAG))
    };
    let (blob, rk) = if fits(body.len()) {
        (body, None)
    } else if let Some(at) = body.len().checked_sub(RK_LEN).filter(|at| fits(*at)) {
        let (blob, rk) = body.split_at(at);
        (blob, Some(rk.try_into().expect("split at the key length")))
    } else {
        return Err(Error::BadRequest("not a relayed settlement"));
    };
    Ok(Body {
        key_id: blob[0],
        enc: blob[1..HEADER].try_into().expect("a header holds enc"),
        ciphertext: &blob[HEADER..],
        rk,
        id: hex::encode(sha2::Sha256::digest(blob)),
    })
}

/// A word that passed every check the gateway can make before the payment settles.
#[derive(Debug, PartialEq)]
pub struct ValidWord {
    pub commitment: Commitment,
    pub part: WordPart,
}

/// What a relayed message comes to: the settlement it asks for, and the word that goes with it
/// when the word holds. An invalid word never blocks the payment.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub settlement: SettlementRequest,
    pub word: Option<ValidWord>,
}

/// The settlement of `inner` and its word, if the word is genuine: the commitment decodes, names
/// the issue's mint and lock, is signed by the issuer, its proof verifies under its root, and its
/// whole interval fits in a quarter of the bond.
pub fn plan_relayed(inner: &Inner, domain: &[u8; 32], issue: &Issue, lock: &Lock) -> Plan {
    let settlement = SettlementRequest {
        issue: hex::encode(&inner.issue),
        spends: inner.spends.iter().map(hex::encode).collect(),
    };
    let word = inner
        .word
        .as_ref()
        .and_then(|part| genuine(part, domain, issue, lock));
    Plan { settlement, word }
}

fn genuine(part: &WordPart, domain: &[u8; 32], issue: &Issue, lock: &Lock) -> Option<ValidWord> {
    let commitment = Commitment::decode(&part.commitment).ok()?;
    let proof = WordProof::decode(&part.proof, commitment.depth).ok()?;
    let signed = commitment.mint == issue.mint
        && commitment.lock_seq == issue.lock_seq
        && lock.mint.to_bytes() == commitment.mint
        && commitment.total()? <= lock.bond / 4
        && payword::verify_word(&commitment.root, commitment.depth, &proof);
    let envelope = payword::payword_signing(domain, &commitment).ok()?;
    (signed && verify_signature(&issue.issuer, &envelope, &part.signature).is_ok()).then(|| {
        ValidWord {
            commitment,
            part: part.clone(),
        }
    })
}

#[derive(Debug, PartialEq)]
pub enum FinalReason {
    Invalid,
    Window,
    Conflict,
    Lock,
    StaleKey,
    BelowFee,
    /// A nullifier of the claim is spent already.
    Spent,
    /// The claim does not repay what it costs the gateway, or names another fee ceiling.
    Fee,
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
        let mut bytes = serde_json::to_vec(&self.body()).expect("an answer is JSON");
        bytes.resize(RESPONSE_PAD, 0);
        bytes
    }

    /// The JSON of the answer.
    pub fn body(&self) -> serde_json::Value {
        match self {
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
                    FinalReason::StaleKey => "stale_key",
                    FinalReason::BelowFee => "below_fee",
                    FinalReason::Spent => "spent",
                    FinalReason::Fee => "fee",
                },
            }),
        }
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
                Error::Settlement(Problem::StaleKey) => FinalReason::StaleKey,
                Error::Settlement(Problem::BelowFee) => FinalReason::BelowFee,
                Error::Settlement(Problem::Spent) => FinalReason::Spent,
                Error::Settlement(Problem::Fee) => FinalReason::Fee,
                _ => FinalReason::Invalid,
            },
        },
        Err(Error::Settlement(Problem::CapExhausted(seconds))) => Answer::Retry {
            retry_after: u64::from(*seconds),
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

impl Relay {
    /// Counts one request from `ip` in the relay's buckets: `false` when either is spent.
    pub fn admit(&self, ip: IpAddr) -> bool {
        self.per_prefix.check(ip.into()).is_ok() && self.wide.check(RELAY_PREFIX).is_ok()
    }
}

pub(crate) async fn limit(state: &Gateway, ip: IpAddr, request: Request, next: Next) -> Response {
    if !state.relay.admit(ip) {
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
        words::release_if_settled(&state, &job.key).await;
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
    let Ok(parts) = split_body(&body) else {
        return Error::BadRequest("not a relayed settlement").into_response();
    };
    let info = hpke::info("relay", &state.settings.genesis_hash);
    let (plain, exporter) = match state.hpke.open_with_export_at(
        u64::from(local_now()),
        parts.key_id,
        &parts.enc,
        parts.ciphertext,
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
    let inner = match parse_inner(&plain) {
        Ok(inner) => inner,
        Err(problem) => return problem.into_response(),
    };
    let ask = parts.rk.map(|rk| (rk, parts.id));
    sealed(&exporter, &parts.enc, &settle(&state, inner, ask).await)
}

/// The word of a message, once it is known to be genuine, and the relayer it is asked for.
async fn bound(
    state: &Gateway,
    inner: &Inner,
    issue: &Issue,
    ask: (&[u8; RK_LEN], &str),
) -> Result<Option<Binding>, Error> {
    let program = state.settings.program;
    let lock = program.find_lock_pda(&issue.issuer, issue.lock_seq).0;
    let Some(account) = read(state, &[lock]).await?.remove(0) else {
        return Ok(None);
    };
    let Ok(lock) = Lock::from_bytes(&account.data) else {
        return Ok(None);
    };
    let domain = domain(
        purpose::PAYWORD,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let plan = plan_relayed(inner, &domain, issue, &lock);
    Ok(plan.word.map(|word| Binding {
        blob_id: ask.1.to_owned(),
        rk: hex::encode(ask.0),
        issuer: hex::encode(issue.issuer),
        commitment: hex::encode(&word.part.commitment),
        signature: hex::encode(word.part.signature),
        proof: hex::encode(&word.part.proof),
    }))
}

/// Inspects the settlement, checks the limits it would meet, writes the job down with the word of
/// the post that writes it, and answers `submitted` only then.
async fn settle(state: &Arc<Gateway>, inner: Inner, ask: Option<([u8; RK_LEN], String)>) -> Answer {
    let request = SettlementRequest {
        issue: hex::encode(&inner.issue),
        spends: inner.spends.iter().map(hex::encode).collect(),
    };
    let key = settlements::job_key(&request);
    let job = match inspect_settlement(state, RELAY_PREFIX, &request).await {
        Ok(Planned::Send(job)) => *job,
        other => {
            if let Err(Error::Settlement(
                Problem::Conflict(_) | Problem::Lock("insufficient_backing"),
            )) = &other
            {
                claims::file_in_background(Arc::clone(state), request);
            } else if let (Err(error), Some((_, id))) = (&other, &ask)
                && settlements::ended(error).is_some()
                && inner.word.is_some()
            {
                words::forget(state, id);
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
    let word = match (&ask, parse_issue(&request.issue)) {
        (Some((rk, id)), Ok(issue)) => {
            match bound(state, &inner, &issue.message, (rk, id.as_str())).await {
                Ok(word) => word,
                Err(error) => return answer_for(&Err(error)),
            }
        }
        _ => None,
    };
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
            zk: None,
            word,
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

/// `GET /v1/relay/{id}/word`: the word of the blob `id`, sealed to the key of the post that wrote
/// its job. `404` while the job is pending, `410` when it ended without a word for anyone.
pub(crate) async fn word(State(state): State<Arc<Gateway>>, Path(id): Path<String>) -> Response {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Error::BadRequest("not a blob id").into_response();
    }
    let id = id.to_ascii_lowercase();
    if state.words.outcome(&id).is_none()
        && let Some(job) = state.jobs.bound_to(&id)
        && let Some(binding) = &job.word
    {
        words::release_job(&state, &job, binding).await;
    }
    match state.words.outcome(&id) {
        Some(Outcome::Released(envelope)) => (
            StatusCode::OK,
            [(CONTENT_TYPE, "application/octet-stream")],
            hex::decode(envelope).unwrap_or_default(),
        )
            .into_response(),
        Some(Outcome::Unfunded | Outcome::Gone) => StatusCode::GONE.into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
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

    use buckspay_protocol::{
        Caveats, Issue,
        caveats::{Owner, ScopeKind},
    };
    use p256::ecdsa::{SigningKey, signature::Signer};

    const MINT: [u8; 32] = [4; 32];
    const GENESIS: [u8; 32] = [5; 32];
    const PROGRAM: [u8; 32] = [6; 32];

    fn domain_of() -> [u8; 32] {
        domain(purpose::PAYWORD, &GENESIS, &PROGRAM)
    }

    fn lock(bond: u64) -> Lock {
        Lock {
            discriminator: [0; 8],
            mint: solana_pubkey::Pubkey::new_from_array(MINT),
            bond,
            backing: 0,
            lock_until: 0,
            bump: 255,
            escrow_bump: 255,
        }
    }

    /// A kind 2 message for a channel of 16 words worth `word_value` each, and what it is built of.
    struct Kind2 {
        bytes: Vec<u8>,
        issue: Issue,
        commitment: Commitment,
        part: WordPart,
    }

    fn proof_of(words: &[[u8; 32]], index: usize) -> WordProof {
        let mut level: Vec<[u8; 32]> = words
            .iter()
            .enumerate()
            .map(|(i, w)| payword::leaf(i as u16, w))
            .collect();
        let (mut at, mut path) = (index, vec![]);
        while level.len() > 1 {
            path.push(level[at ^ 1]);
            level = level
                .chunks(2)
                .map(|pair| payword::node(&pair[0], &pair[1]))
                .collect();
            at /= 2;
        }
        WordProof {
            index: index as u16,
            word: words[index],
            path,
        }
    }

    fn kind2(word_value: u64) -> Kind2 {
        let key = SigningKey::from_slice(&[9; 32]).unwrap();
        let issuer: [u8; 33] = key
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap();
        let words: Vec<[u8; 32]> = (0..16u8).map(|i| [i + 1; 32]).collect();
        let commitment = Commitment {
            mint: MINT,
            lock_seq: 2,
            cum_end: 1_000_000,
            depth: 4,
            word_value,
            root: payword::root(&words),
            expiry: 5_000,
        };
        let envelope = payword::payword_signing(&domain_of(), &commitment).unwrap();
        let signed: p256::ecdsa::Signature = key.sign(&envelope);
        let signature: [u8; 64] = signed.normalize_s().to_bytes().into();
        let proof = proof_of(&words, 3).encode();
        let issue_bytes = vec![7u8; 227];
        let mut plain = vec![1u8, 2];
        plain.extend((issue_bytes.len() as u16).to_be_bytes());
        plain.extend(&issue_bytes);
        plain.push(0);
        plain.extend(commitment.encode());
        plain.extend(signature);
        plain.extend((proof.len() as u16).to_be_bytes());
        plain.extend(&proof);
        plain.resize(1024, 0);
        Kind2 {
            bytes: plain,
            issue: Issue {
                issuer,
                mint: MINT,
                lock_seq: 2,
                cum_end: 900_000,
                salt: [0; 16],
                owner: Owner::Account([1; 32]),
                amount: 10,
                caveats: Caveats {
                    expiry: 9_000,
                    hops_left: 1,
                    flags: 0,
                    scope_kind: ScopeKind::Any,
                    scope: [0; 20],
                },
            },
            commitment,
            part: WordPart {
                commitment: commitment.encode().to_vec(),
                signature,
                proof,
            },
        }
    }

    fn planned(k: &Kind2, bond: u64) -> Plan {
        plan_relayed(
            &parse_inner(&k.bytes).unwrap(),
            &domain_of(),
            &k.issue,
            &lock(bond),
        )
    }

    #[test]
    fn kind_two_inner_round_trips_and_kind_one_still_parses() {
        let k2 = kind2(6);
        let inner_two = parse_inner(&k2.bytes).unwrap();
        assert_eq!(inner_two.word.as_ref().unwrap(), &k2.part);
        assert_eq!(
            Commitment::decode(&k2.part.commitment).unwrap(),
            k2.commitment
        );
        let plain = inner(&[7; 227], &[], 1024);
        assert!(parse_inner(&plain).unwrap().word.is_none());
    }

    #[test]
    fn body_with_and_without_rk_is_accepted_and_other_lengths_are_not() {
        for bucket in BUCKETS {
            let body = vec![0u8; bucket + HEADER + TAG];
            assert!(split_body(&body).unwrap().rk.is_none());
            let mut with = body.clone();
            with.extend([7u8; RK_LEN]);
            let split = split_body(&with).unwrap();
            assert_eq!(split.rk, Some([7u8; RK_LEN]));
            assert_eq!(
                split.id,
                split_body(&body).unwrap().id,
                "the id does not depend on rk"
            );
            let mut odd = body.clone();
            odd.push(0);
            assert!(split_body(&odd).is_err());
        }
        assert!(split_body(&vec![0; MAX_RELAY_BYTES + 1]).is_err());
    }

    #[test]
    fn an_invalid_word_still_settles_the_payment_without_a_word() {
        let good = kind2(6);
        assert!(planned(&good, 400).word.is_some());
        let mut path_corrupted = kind2(6);
        let mut part = path_corrupted.part.clone();
        *part.proof.last_mut().unwrap() ^= 1;
        let mut inner = parse_inner(&path_corrupted.bytes).unwrap();
        inner.word = Some(part);
        let plan = plan_relayed(&inner, &domain_of(), &path_corrupted.issue, &lock(400));
        assert!(plan.word.is_none());
        assert_eq!(plan.settlement, planned(&good, 400).settlement);
        path_corrupted.issue.lock_seq += 1;
        assert!(planned(&path_corrupted, 400).word.is_none(), "another lock");
        let mut other_mint = kind2(6);
        other_mint.issue.mint = [8; 32];
        assert!(planned(&other_mint, 400).word.is_none(), "another mint");
        let mut other_issuer = kind2(6);
        other_issuer.issue.issuer[5] ^= 1;
        assert!(
            planned(&other_issuer, 400).word.is_none(),
            "not the issuer's signature"
        );
    }

    #[test]
    fn a_commitment_above_a_quarter_of_the_bond_releases_no_word() {
        assert!(planned(&kind2(6), 400).word.is_some(), "96 of 100");
        assert!(planned(&kind2(7), 400).word.is_none(), "112 of 100");
    }

    #[test]
    fn a_word_part_cut_short_or_followed_by_junk_is_dropped_and_the_payment_stays() {
        let mut junk = kind2(6).bytes;
        *junk.last_mut().unwrap() = 1;
        assert!(parse_inner(&junk).unwrap().word.is_none());
        let mut short = vec![1u8, 2];
        short.extend(227u16.to_be_bytes());
        short.extend([7u8; 227]);
        short.push(0);
        short.extend([3u8; 91 + 64]);
        short.extend(u16::MAX.to_be_bytes());
        short.resize(1024, 0);
        let parsed = parse_inner(&short).unwrap();
        assert!(parsed.word.is_none());
        assert_eq!(parsed.issue.len(), 227);
    }

    #[test]
    fn prints_the_tip_the_app_builds() {
        let k = kind2(6);
        let parsed = parse_inner(&k.bytes).unwrap();
        let word = parsed.word.unwrap();
        let vector = json!({
            "issue": hex::encode(&parsed.issue),
            "commitment": hex::encode(&word.commitment),
            "signature": hex::encode(word.signature),
            "proof": hex::encode(&word.proof),
            "inner": hex::encode(&k.bytes),
        });
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/vectors/inner-kind2.json"
        );
        let text = serde_json::to_string_pretty(&vector).unwrap() + "\n";
        if std::env::var_os("WRITE_VECTORS").is_some() {
            std::fs::write(path, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }

    #[test]
    fn parses_an_inner_settlement_with_padding() {
        let p = parse_inner(&inner(&[7; 140], &[&[8; 150]], 1024)).unwrap();
        assert_eq!(p.issue, vec![7; 140]);
        assert_eq!(p.spends, vec![vec![8; 150]]);
    }

    #[test]
    fn parses_an_issue_with_no_spend() {
        let p = parse_inner(&inner(&[7; 140], &[], 1024)).unwrap();
        assert!(p.spends.is_empty());
    }

    #[test]
    fn refuses_nonzero_padding_unknown_kind_and_bad_counts() {
        let mut v = inner(&[7; 140], &[&[8; 150]], 1024);
        *v.last_mut().unwrap() = 1;
        assert!(parse_inner(&v).is_err());
        let mut k = inner(&[7; 140], &[&[8; 10]], 1024);
        k[1] = 3;
        assert!(parse_inner(&k).is_err());
        assert!(parse_inner(&inner(&[7; 140], &[&[8u8; 10] as &[u8]; 17], 8192)).is_err());
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
