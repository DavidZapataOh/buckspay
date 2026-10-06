//! Chains longer than one precompile instruction: batches resume from the records.
mod common;
use anchor_lang::{
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    InstructionData,
};
use buckspay::{records::PAID, BuckspayError as E};
use buckspay_protocol::secp256r1::MAX_SIGNATURES;
use common::*;
use solana_signer::Signer;
use solana_transaction::TransactionError;

const AMOUNT: u64 = 64_000_000;
/// What loading the accounts of each instruction costs before its handler runs (measured: 22.6k
/// and 15.0k); a refusal that walked the 17 links first would cost well above these.
const SETTLE_ACCOUNTS_ONLY: u64 = 26_000;
const RECORD_ACCOUNTS_ONLY: u64 = 18_000;

struct W {
    env: Env,
    issuer: Issuer,
    holders: Vec<Issuer>,
    payee: Pubkey,
    payee_token: Pubkey,
    expiry: u32,
}

fn world(holders: usize) -> W {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 400_000_000, 1_000_000_000, 60);
    let holders = (0..holders)
        .map(|i| env.issuer(10 + i as u8, 1_000_000, 10_000_000, 60))
        .collect();
    let payee = Pubkey::new_unique();
    let payee_token = env.token_account_of(&payee, 0);
    let expiry = expiry_of(&env, 10);
    W {
        env,
        issuer,
        holders,
        payee,
        payee_token,
        expiry,
    }
}

impl W {
    fn chain(&self, hop: Hop) -> Chain {
        let holders: Vec<&Issuer> = self.holders.iter().collect();
        Chain::long(
            &self.issuer,
            &self.env.mint,
            AMOUNT,
            &holders,
            &self.payee,
            hop,
            self.expiry,
        )
    }
    fn record(
        &mut self,
        chain: &Chain,
        spends: usize,
        covered: usize,
    ) -> Result<Landed, TransactionError> {
        let payer = self.env.payer.pubkey();
        let ixs = record_prefix_ixs(&payer, &self.issuer, &chain.prefix(spends), covered);
        self.env.send_v1(&ixs)
    }
    fn settle(&mut self, chain: &Chain, covered: usize) -> Result<Landed, TransactionError> {
        let payer = self.env.payer.pubkey();
        let ixs = settle_ixs_resumed(
            &self.env,
            &payer,
            &self.issuer,
            chain,
            &self.payee_token,
            covered,
        );
        self.env.send_v1(&ixs)
    }
}

/// Gives the last instruction of `ixs` the links of `chain` plus one more, and one more record
/// account: a chain no valid note has, to show the length is checked before the walk.
fn with_extra_link(ixs: &mut [Instruction], chain: &Chain, record: bool) {
    let mut links = chain.links.clone();
    links.push(links[links.len() - 1].clone());
    let ix = ixs.last_mut().unwrap();
    ix.data = if record {
        buckspay::instruction::RecordPrefix {
            issue: chain.issue_body,
            spends: links,
        }
        .data()
    } else {
        buckspay::instruction::SettleNote {
            issue: chain.issue_body,
            spends: links,
        }
        .data()
    };
    ix.accounts
        .push(AccountMeta::new(Pubkey::new_unique(), false));
}

/// Fails before: `record_prefix` of 13 spends is refused with `TooManySpends`.
#[test]
fn a_sixteen_spend_chain_settles_in_three_batches_and_pays_once() {
    let mut w = world(16);
    let chain = w.chain(Hop::Two);
    assert_eq!(chain.links.len(), 16);
    let a = w.record(&chain, 7, 0).unwrap();
    let b = w.record(&chain, 13, 8).unwrap();
    let c = w.settle(&chain, 14).unwrap();
    for (name, l) in [("prefix 7", &a), ("prefix 13", &b), ("settle 16", &c)] {
        eprintln!("{name}: {} CU, {} B", l.units, l.size);
        assert!(l.size <= 4_096 && l.units <= 200_000, "{name} over budget");
    }
    let paid = chain_last_output(&chain).amount;
    assert_eq!(w.env.balance(&w.payee_token), paid);
    let outputs = consumed_outputs(&chain);
    assert_eq!(w.env.spent(&outputs[15]).unwrap().flags, PAID);
    assert!(outputs[..15]
        .iter()
        .all(|o| w.env.spent(o).unwrap().flags == 0));
    // Paying again is refused and moves nothing.
    assert!(w.settle(&chain, 17).is_err());
    assert_eq!(w.env.balance(&w.payee_token), paid);
}

/// Fails before: refused with `TooManySpends` although only 3 signatures are left to verify.
#[test]
fn ten_spends_with_seven_recorded_need_only_the_last_three_signatures() {
    let mut w = world(10);
    let chain = w.chain(Hop::One);
    w.record(&chain, 7, 0).unwrap();
    let landed = w.settle(&chain, 8).unwrap();
    assert!(landed.size <= 4_096);
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
}

/// Passes before and after (pinned): nine messages left to verify are refused before any
/// signature is checked, by the program and not only by the precompile. The instruction carries
/// the last 8 entries (`covered = 3`) while the records give `start = 2`.
#[test]
fn nine_messages_left_to_verify_are_refused_with_too_many_spends() {
    let mut w = world(10);
    let chain = w.chain(Hop::One);
    w.record(&chain, 1, 0).unwrap();
    let err = w.settle(&chain, 3).unwrap_err();
    assert_eq!(err, code(1, E::TooManySpends));
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

/// Fails before only in its error: a 17-spend settlement is refused before the walk.
#[test]
fn a_chain_longer_than_max_depth_is_refused_before_it_is_walked() {
    let mut w = world(16);
    let chain = w.chain(Hop::One);
    let payer = w.env.payer.pubkey();
    let mut ixs = settle_ixs_resumed(&w.env, &payer, &w.issuer, &chain, &w.payee_token, 10);
    with_extra_link(&mut ixs, &chain, false);
    let (err, units) = w.env.failed_v1(&ixs);
    assert_eq!(err, code(1, E::TooManySpends));
    assert!(
        units < SETTLE_ACCOUNTS_ONLY,
        "walked {units} CU before refusing"
    );
}

/// Fails before only in its error: a 17-spend `record_prefix` is refused before the walk.
#[test]
fn a_seventeen_link_record_prefix_is_refused_before_it_is_walked() {
    let mut w = world(16);
    let chain = w.chain(Hop::One);
    let payer = w.env.payer.pubkey();
    let mut ixs = record_prefix_ixs(&payer, &w.issuer, &chain, 10);
    with_extra_link(&mut ixs, &chain, true);
    let (err, units) = w.env.failed_v1(&ixs);
    assert_eq!(err, code(1, E::TooManySpends));
    assert!(
        units < RECORD_ACCOUNTS_ONLY,
        "walked {units} CU before refusing"
    );
}

/// Passes before and after (pinned): a `record_prefix` with nine messages left to verify is
/// refused with `TooManySpends` by the program; the instruction carries the last 8 entries.
#[test]
fn a_record_prefix_with_nine_messages_to_verify_is_refused_with_too_many_spends() {
    let mut w = world(10);
    let chain = w.chain(Hop::One);
    let err = w.record(&chain, 9, 2).unwrap_err();
    assert_eq!(err, code(1, E::TooManySpends));
}

/// Passes before and after (pinned): a batch that resumes with a different body for a recorded
/// output stops at that output with `ConflictingSpend`, and the records already written stay.
#[test]
fn a_resumed_batch_with_another_body_for_a_recorded_output_is_a_conflict() {
    let mut w = world(10);
    let chain = w.chain(Hop::One);
    w.record(&chain, 7, 0).unwrap();
    let mut other = chain.clone();
    other.resign_link(&w.holders[3].key, 3, 0xEE);
    let err = w.record(&other, 4, 3).unwrap_err();
    assert_eq!(err, code(1, E::ConflictingSpend));
    assert_eq!(
        w.env.spent(&consumed_outputs(&chain)[3]).unwrap().content,
        buckspay_protocol::hash::content(&chain.links[3].body)
    );
}

/// Fails before: a prefix of 8 to 16 spends cannot be recorded at all.
#[test]
fn record_prefix_accepts_up_to_max_depth_spends_with_at_most_eight_signatures() {
    let mut w = world(16);
    let chain = w.chain(Hop::Two);
    w.record(&chain, 7, 0).unwrap();
    w.record(&chain, 13, 8).unwrap();
    assert!(w.record(&chain, 15, 14).is_ok());
    assert_eq!(MAX_SIGNATURES, 8);
}
