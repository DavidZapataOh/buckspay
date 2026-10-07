//! Delivery words: the word a payer attached to a relayed payment goes to the relayer whose post
//! wrote the job, once the payment has settled and the payer's lock still backs it.
use crate::{
    chain::CLOCK_SYSVAR,
    hpke,
    jobs::{JobState, SettlementJob, write_atomic},
    onboard::{chain_now, local_now, read},
    server::Gateway,
};
use ::hpke::{
    Deserializable, Kem, OpModeS, Serializable, aead::ChaCha20Poly1305, kdf::HkdfSha256,
    kem::X25519HkdfSha256,
};
use buckspay_client::accounts::{Channel, Ledger, RewardMint};
use buckspay_protocol::{
    GRACE,
    payword::{Commitment, WordProof},
};
use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tracing::warn;

pub const WORD_AAD: &[u8] = b"buckspay/word/v1";
/// Every sealed word has this plaintext length: `commitment 91 ‖ sig 64 ‖ word proof`, padded.
pub const WORD_PAD: usize = 512;

/// What the first post that wrote a job asked for, kept in the job.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub blob_id: String,
    /// The relayer key the word is sealed to, hex.
    pub rk: String,
    pub issuer: String,
    pub commitment: String,
    pub signature: String,
    pub proof: String,
}

struct Parts {
    commitment: Commitment,
    proof: WordProof,
    issuer: [u8; 33],
    rk: [u8; 32],
}

impl Binding {
    fn parts(&self) -> Option<Parts> {
        let commitment = Commitment::decode(&hex::decode(&self.commitment).ok()?).ok()?;
        let proof = WordProof::decode(&hex::decode(&self.proof).ok()?, commitment.depth).ok()?;
        Some(Parts {
            commitment,
            proof,
            issuer: hex::decode(&self.issuer).ok()?.try_into().ok()?,
            rk: hex::decode(&self.rk).ok()?.try_into().ok()?,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// `enc ‖ ciphertext`, hex.
    Released(String),
    /// The lock no longer backs the word: nothing is sealed.
    Unfunded,
    /// The job ended without settling.
    Gone,
}

/// What the gateway kept of a channel whose word it released: whatever a relayer needs to settle
/// without knowing the payer.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChannelRecord {
    pub issuer: Vec<u8>,
    pub commitment: Vec<u8>,
    pub signature: Vec<u8>,
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    /// `(channel hash, index)` to the blob its word was released for.
    slots: BTreeMap<String, String>,
    /// By channel hash: the record and the second after which it is forgotten.
    channels: BTreeMap<String, (ChannelRecord, u32)>,
    /// By blob: the outcome and the second after which it is forgotten.
    outcomes: BTreeMap<String, (Outcome, u32)>,
}

/// The words released and refused, by blob. A restart keeps them.
#[derive(Default)]
pub struct Words {
    path: Option<PathBuf>,
    state: Mutex<State>,
}

fn slot(channel: &[u8; 32], index: u16) -> String {
    format!("{}:{index}", hex::encode(channel))
}

impl Words {
    pub fn open(path: &Path) -> Result<Self, String> {
        let state = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self {
            path: Some(path.to_owned()),
            state: Mutex::new(state),
        })
    }

    fn save(&self, state: &State) -> io::Result<()> {
        match &self.path {
            Some(path) => write_atomic(path, state),
            None => Ok(()),
        }
    }

    pub fn outcome(&self, blob_id: &str) -> Option<Outcome> {
        self.state
            .lock()
            .unwrap()
            .outcomes
            .get(blob_id)
            .map(|(outcome, _)| outcome.clone())
    }

    /// Words released for `channel` so far.
    pub fn released_for(&self, channel: &[u8; 32]) -> usize {
        let prefix = format!("{}:", hex::encode(channel));
        self.state
            .lock()
            .unwrap()
            .slots
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .count()
    }

    /// The record of a channel one of whose words was released.
    pub fn channel(&self, channel: &[u8; 32]) -> Option<ChannelRecord> {
        self.state
            .lock()
            .unwrap()
            .channels
            .get(&hex::encode(channel))
            .map(|(record, _)| record.clone())
    }

    /// Whether the word at `(channel, index)` was released to anyone.
    pub fn is_released(&self, channel: &[u8; 32], index: u16) -> bool {
        self.state
            .lock()
            .unwrap()
            .slots
            .contains_key(&slot(channel, index))
    }

    /// Releases the word at `(channel, index)` to `blob_id`, unless it was released before.
    fn release(
        &self,
        record: &ChannelRecord,
        channel: &[u8; 32],
        index: u16,
        blob_id: &str,
        envelope: &[u8],
        until: u32,
    ) -> io::Result<bool> {
        let mut state = self.state.lock().unwrap();
        let key = slot(channel, index);
        if state.slots.contains_key(&key) || state.outcomes.contains_key(blob_id) {
            return Ok(false);
        }
        state.slots.insert(key, blob_id.to_owned());
        state
            .channels
            .insert(hex::encode(channel), (record.clone(), until));
        state.outcomes.insert(
            blob_id.to_owned(),
            (Outcome::Released(hex::encode(envelope)), until),
        );
        self.save(&state)?;
        Ok(true)
    }

    /// Records that a blob will never have a word. A word released stays released.
    pub fn refuse(&self, blob_id: &str, outcome: Outcome, until: u32) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.outcomes.contains_key(blob_id) {
            return Ok(());
        }
        state.outcomes.insert(blob_id.to_owned(), (outcome, until));
        self.save(&state)
    }

    /// Forgets what ended before `now`.
    pub fn sweep(&self, now: u32) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        let before = state.outcomes.len();
        state.outcomes.retain(|_, (_, until)| *until > now);
        if state.outcomes.len() == before {
            return Ok(());
        }
        let State {
            slots,
            channels,
            outcomes,
        } = &mut *state;
        slots.retain(|_, blob| outcomes.contains_key(blob));
        channels.retain(|_, (_, until)| *until > now);
        self.save(&state)
    }
}

/// Records that the blob `blob_id` ended for good before it had a job.
pub(crate) fn forget(state: &Gateway, blob_id: &str) {
    let until = local_now().saturating_add(KEEP_GONE);
    finish(state.words.refuse(blob_id, Outcome::Gone, until));
}

/// Seconds a blob refused before it had a job is remembered.
const KEEP_GONE: u32 = 86_400;

/// `enc ‖ ciphertext` of `plain` sealed to the relayer key `rk`.
pub fn seal_word(rk: &[u8; 32], genesis_hash: &[u8; 32], plain: &[u8]) -> Option<Vec<u8>> {
    let public = <X25519HkdfSha256 as Kem>::PublicKey::from_bytes(rk).ok()?;
    let (enc, mut context) =
        ::hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
            &OpModeS::Base,
            &public,
            &hpke::info("word", genesis_hash),
        )
        .ok()?;
    let ciphertext = context.seal(plain, WORD_AAD).ok()?;
    Some([enc.to_bytes().as_slice(), &ciphertext].concat())
}

/// Whether a lock's unspent backing covers one more word of a channel, besides the words already
/// released for it and not yet settled, each worth `word_value`.
pub fn funded(backing_left: u64, word_value: u64, unsettled_released: u64) -> bool {
    unsettled_released
        .checked_add(1)
        .and_then(|words| words.checked_mul(word_value))
        .is_some_and(|needed| backing_left >= needed)
}

/// Releases the word of a job that settled, or writes why it never will be. Nothing happens while
/// the job is pending, and a read that fails leaves the decision for the next call.
pub(crate) async fn release_if_settled(state: &Gateway, key: &str) {
    if let Some(job) = state.jobs.get(key)
        && let Some(binding) = job.word.clone()
    {
        release_job(state, &job, &binding).await;
    }
}

pub(crate) async fn release_job(state: &Gateway, job: &SettlementJob, binding: &Binding) {
    let Some(Parts {
        commitment,
        proof,
        issuer,
        rk,
    }) = binding.parts()
    else {
        return;
    };
    let until = commitment.expiry.saturating_add(GRACE);
    match job.state {
        JobState::Pending => return,
        JobState::Done => {}
        _ => {
            finish(state.words.refuse(&binding.blob_id, Outcome::Gone, until));
            return;
        }
    }
    if state.words.outcome(&binding.blob_id).is_some() {
        return;
    }
    let program = state.settings.program;
    let lock = program.find_lock_pda(&issuer, commitment.lock_seq).0;
    let hash = commitment.hash();
    let channel =
        Pubkey::find_program_address(&[b"channel", lock.as_ref(), &hash], &program.id()).0;
    let reward_mint =
        Pubkey::find_program_address(&[b"reward-mint", &commitment.mint], &program.id()).0;
    let Ok(accounts) = read(
        state,
        &[
            program.find_ledger_pda(&lock).0,
            channel,
            reward_mint,
            CLOCK_SYSVAR,
        ],
    )
    .await
    else {
        return;
    };
    let Ok(now) = chain_now(&accounts[3]) else {
        return;
    };
    let backing_left = accounts[0]
        .as_ref()
        .and_then(|account| Ledger::from_bytes(&account.data).ok())
        .map(|ledger| ledger.backing_left);
    let settled: u64 = accounts[1]
        .as_ref()
        .and_then(|account| Channel::from_bytes(&account.data).ok())
        .map_or(0, |channel| {
            channel
                .settled
                .iter()
                .map(|byte| u64::from(byte.count_ones()))
                .sum()
        });
    let unsettled = (state.words.released_for(&hash) as u64).saturating_sub(settled);
    let mint_value = accounts[2]
        .as_ref()
        .and_then(|account| RewardMint::from_bytes(&account.data).ok())
        .map(|mint| mint.word_value);
    let backed = backing_left.is_some_and(|left| funded(left, commitment.word_value, unsettled));
    if !(backed && now < until && mint_value == Some(commitment.word_value)) {
        finish(
            state
                .words
                .refuse(&binding.blob_id, Outcome::Unfunded, until),
        );
        return;
    }
    let mut plain = [
        hex::decode(&binding.commitment).unwrap_or_default(),
        hex::decode(&binding.signature).unwrap_or_default(),
        proof.encode(),
    ]
    .concat();
    plain.resize(WORD_PAD, 0);
    let Some(envelope) = seal_word(&rk, &state.settings.genesis_hash, &plain) else {
        finish(state.words.refuse(&binding.blob_id, Outcome::Gone, until));
        return;
    };
    let record = ChannelRecord {
        issuer: issuer.to_vec(),
        commitment: hex::decode(&binding.commitment).unwrap_or_default(),
        signature: hex::decode(&binding.signature).unwrap_or_default(),
    };
    match state.words.release(
        &record,
        &hash,
        proof.index,
        &binding.blob_id,
        &envelope,
        until,
    ) {
        Ok(true) => {}
        Ok(false) => finish(state.words.refuse(&binding.blob_id, Outcome::Gone, until)),
        Err(error) => warn!(%error, "a word could not be written; none was released"),
    }
}

fn finish(result: io::Result<()>) {
    if let Err(error) = result {
        warn!(%error, "a word outcome could not be written");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> ChannelRecord {
        ChannelRecord {
            issuer: vec![2; 33],
            commitment: vec![1; 91],
            signature: vec![3; 64],
        }
    }

    #[test]
    fn a_word_needs_the_backing_of_every_released_word_of_its_channel_and_itself() {
        assert!(funded(500_000, 500_000, 0));
        assert!(!funded(499_999, 500_000, 0));
        assert!(funded(1_500_000, 500_000, 2));
        assert!(!funded(1_499_999, 500_000, 2));
        assert!(!funded(u64::MAX, u64::MAX, 1), "the product overflows");
        assert!(!funded(u64::MAX, 1, u64::MAX), "the count overflows");
    }

    #[test]
    fn a_slot_is_released_once_and_a_refusal_never_replaces_a_release() {
        let words = Words::default();
        let (channel, other) = ([1u8; 32], [2u8; 32]);
        assert!(
            words
                .release(&record(), &channel, 3, "a", b"first", 100)
                .unwrap()
        );
        assert!(
            !words
                .release(&record(), &channel, 3, "b", b"second", 100)
                .unwrap()
        );
        assert!(
            words
                .release(&record(), &other, 3, "c", b"third", 100)
                .unwrap()
        );
        assert!(words.is_released(&channel, 3));
        assert!(!words.is_released(&channel, 4));
        assert_eq!(words.channel(&channel), Some(record()));
        words.refuse("a", Outcome::Gone, 100).unwrap();
        assert_eq!(
            words.outcome("a"),
            Some(Outcome::Released(hex::encode(b"first")))
        );
        assert_eq!(words.outcome("b"), None);
        assert_eq!(words.released_for(&channel), 1);
    }

    #[test]
    fn what_ended_is_forgotten_with_its_slot() {
        let words = Words::default();
        words
            .release(&record(), &[1; 32], 0, "a", b"w", 100)
            .unwrap();
        words.refuse("b", Outcome::Unfunded, 200).unwrap();
        words.sweep(100).unwrap();
        assert_eq!(words.outcome("a"), None);
        assert_eq!(words.released_for(&[1; 32]), 0);
        assert_eq!(words.outcome("b"), Some(Outcome::Unfunded));
    }

    #[test]
    fn released_words_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("words.json");
        Words::open(&path)
            .unwrap()
            .release(&record(), &[9; 32], 1, "a", b"w", 100)
            .unwrap();
        let reopened = Words::open(&path).unwrap();
        assert_eq!(reopened.released_for(&[9; 32]), 1);
        assert!(
            !reopened
                .release(&record(), &[9; 32], 1, "b", b"x", 100)
                .unwrap()
        );
    }
}
