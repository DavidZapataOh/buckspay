//! Settling a chain in two transactions: `record_prefix` records the consumed outputs, the
//! settlement then carries only the signatures nothing on chain vouches for.
mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::{records::PAID, BuckspayError as E};
use buckspay_protocol::{
    hash::content, lock::EXPIRY_STEP, Caveats, Outputs, Owner, Spend, GRACE, NO_LOCK,
};
use common::*;
use solana_signer::Signer;

const AMOUNT: u64 = 50_000_000;
const BACKING: u64 = 1_000_000_000;

struct W {
    env: Env,
    issuer: Issuer,
    holder: Issuer,
    second: Issuer,
    payee: Pubkey,
    payee_token: Pubkey,
    expiry: u32,
}

fn world() -> W {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, BACKING, 60);
    let holder = env.issuer(2, 1_000_000, 10_000_000, 60);
    let second = env.issuer(3, 1_000_000, 10_000_000, 60);
    let payee = Pubkey::new_unique();
    let payee_token = env.token_account_of(&payee, 0);
    let expiry = expiry_of(&env, 10);
    W {
        env,
        issuer,
        holder,
        second,
        payee,
        payee_token,
        expiry,
    }
}

impl W {
    fn issue(&self) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            0,
            AMOUNT,
            self.holder.key.owner(),
            caveats(self.expiry, 6),
        )
    }
    /// The issue handed to the second holder: one message before the settlement.
    fn handed(&self, salt: u8) -> Chain {
        self.issue().spend(&self.holder.key, 0, |c| Spend {
            input: c.id,
            lock_seq: 0,
            salt: [salt; 16],
            outputs: Outputs::One {
                owner: self.second.key.owner(),
                caveats: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
            },
        })
    }
    /// The two-spend chain of the second holder paying `payee`.
    fn two_spends(&self) -> Chain {
        self.handed(7)
            .spend1_to_account(&self.second.key, 0, &self.payee, NO_LOCK, 8)
    }
    fn send(
        &mut self,
        ixs: &[anchor_lang::solana_program::instruction::Instruction],
    ) -> Result<Landed, solana_transaction::TransactionError> {
        self.env.svm.expire_blockhash();
        self.env.submit(ixs)
    }
    fn record(
        &mut self,
        chain: &Chain,
        covered: usize,
    ) -> Result<Landed, solana_transaction::TransactionError> {
        let payer = self.env.payer.pubkey();
        let ixs = record_prefix_ixs(&payer, &self.issuer, chain, covered);
        self.send(&ixs)
    }
    fn settle(
        &mut self,
        chain: &Chain,
        covered: usize,
    ) -> Result<Landed, solana_transaction::TransactionError> {
        let payer = self.env.payer.pubkey();
        let ixs = settle_ixs_resumed(
            &self.env,
            &payer,
            &self.issuer,
            chain,
            &self.payee_token,
            covered,
        );
        self.send(&ixs)
    }
}

#[test]
fn a_chain_of_two_spends_settles_in_two_small_transactions() {
    let mut w = world();
    let chain = w.two_spends();
    let first = w.record(&chain.prefix(1), 0).unwrap();
    let outputs = consumed_outputs(&chain);
    let prefix = w.env.spent(&outputs[0]).unwrap();
    assert_eq!(
        (prefix.flags, prefix.content),
        (0, content(&chain.links[0].body))
    );
    assert_eq!(w.env.balance(&w.payee_token), 0);

    let second = w.settle(&chain, 2).unwrap();
    eprintln!(
        "record_prefix: {} CU, {} B; resumed settlement: {} CU, {} B (legacy)",
        first.units, first.size, second.units, second.size
    );
    assert!(first.size <= 1_232 && second.size <= 1_232);
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
    assert_eq!(
        w.env.spent(&outputs[0]).unwrap().flags,
        0,
        "the prefix record is left as it was"
    );
    assert_eq!(w.env.spent(&outputs[1]).unwrap().flags, PAID);
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, BACKING - AMOUNT);
}

#[test]
fn a_transaction_built_before_the_prefix_was_recorded_still_lands() {
    let mut w = world();
    let chain = w.two_spends();
    let full = settle_ixs(
        &w.env,
        &w.env.payer.pubkey(),
        &w.issuer,
        &chain,
        &w.payee_token,
    );
    w.record(&chain.prefix(1), 0).unwrap();
    w.send(&full).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
}

#[test]
fn what_no_record_vouches_for_must_still_be_signed() {
    let mut w = world();
    let chain = w.two_spends();
    // No record at all: leaving out the issuer's and the first hop's signature is refused.
    assert_eq!(
        w.settle(&chain, 2).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(
        w.settle(&chain, 1).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(
        w.settle(&chain, 3).unwrap_err(),
        code(0, E::ChainVerification)
    );
    // The first hop recorded: the last message is still required.
    w.record(&chain.prefix(1), 0).unwrap();
    assert_eq!(
        w.settle(&chain, 3).unwrap_err(),
        code(0, E::ChainVerification)
    );
    assert_eq!(w.env.balance(&w.payee_token), 0);
    w.settle(&chain, 2).unwrap();
}

#[test]
fn a_record_of_another_content_vouches_for_nothing() {
    let mut w = world();
    let chain = w.two_spends();
    // The holder double spends: the issue is handed to somebody else first and recorded.
    let rival = w.issue().spend(&w.holder.key, 0, |c| Spend {
        input: c.id,
        lock_seq: 0,
        salt: [0x77; 16],
        outputs: Outputs::One {
            owner: Key::new(9).owner(),
            caveats: Caveats {
                hops_left: c.caveats.hops_left - 1,
                ..c.caveats
            },
        },
    });
    w.record(&rival, 0).unwrap();
    // The signatures cannot be skipped for the other branch: refused for lack of them,
    // and with all of them it is a conflict, not a settlement.
    assert_eq!(
        w.settle(&chain, 2).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(
        w.settle(&chain, 0).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

#[test]
fn a_reclaim_record_vouches_for_nothing() {
    let mut w = world();
    let chain = w.two_spends();
    let issue = w.issue();
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE) + 1);
    let payer = w.env.payer.pubkey();
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &issue,
        0,
        &w.holder.key,
        &w.holder.wallet_token,
    );
    w.send(&ixs).unwrap();
    // A clock that runs back into the window of the last consumed output (it expires a step before
    // the issue's): the record of the reclaim is not a spend.
    w.env
        .warp(i64::from(w.expiry) - i64::from(EXPIRY_STEP) + i64::from(GRACE));
    assert_eq!(
        w.settle(&chain, 2).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(
        w.settle(&chain, 0).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

#[test]
fn a_chain_with_another_ancestry_gets_no_shortcut() {
    let mut w = world();
    let chain = w.two_spends();
    w.record(&chain.prefix(1), 0).unwrap();
    // The same spends over an issue that is not the recorded one: every output id differs, so
    // no record vouches for anything and the unsigned issue and first hop are refused.
    let forged = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT + 1,
        w.holder.key.owner(),
        caveats(w.expiry, 6),
    )
    .spend(&w.holder.key, 0, |c| Spend {
        input: c.id,
        lock_seq: 0,
        salt: [7; 16],
        outputs: Outputs::One {
            owner: w.second.key.owner(),
            caveats: Caveats {
                hops_left: c.caveats.hops_left - 1,
                ..c.caveats
            },
        },
    })
    .spend1_to_account(&w.second.key, 0, &w.payee, NO_LOCK, 8);
    assert_ne!(consumed_outputs(&forged)[0], consumed_outputs(&chain)[0]);
    assert_eq!(
        w.settle(&forged, 2).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

#[test]
fn an_unpaid_prefix_is_paid_later_with_no_signature_at_all() {
    let mut w = world();
    let merchant = Pubkey::new_unique();
    let merchant_token = w.env.token_account_of(&merchant, 0);
    let payment = w.issue().spend(&w.holder.key, 0, |c| Spend {
        input: c.id,
        lock_seq: 0,
        salt: [7; 16],
        outputs: Outputs::Two {
            owner0: Owner::Account(merchant.to_bytes()),
            amount0: 20_000_000,
            caveats0: Caveats {
                hops_left: c.caveats.hops_left - 1,
                ..c.caveats
            },
            owner1: w.holder.key.owner(),
        },
    });
    // The change branch is settled first and records the spend as an unpaid prefix.
    let change = payment
        .clone()
        .spend1_to_account(&w.holder.key, 1, &w.payee, NO_LOCK, 3);
    w.settle(&change, 0).unwrap();
    let outputs = consumed_outputs(&payment);
    assert_eq!(w.env.spent(&outputs[0]).unwrap().flags, 0);
    // The payment branch ends with the very message that is on record: nothing is left to verify.
    let payer = w.env.payer.pubkey();
    let ixs = settle_ixs_resumed(&w.env, &payer, &w.issuer, &payment, &merchant_token, 2);
    assert_eq!(ixs.len(), 1, "no precompile instruction at all");
    w.send(&ixs).unwrap();
    assert_eq!(w.env.balance(&merchant_token), 20_000_000);
    assert_eq!(w.env.spent(&outputs[0]).unwrap().flags, PAID);
    // And once more: the same message, paid once.
    let again = settle_ixs_resumed(&w.env, &payer, &w.issuer, &payment, &merchant_token, 2);
    assert_eq!(w.send(&again).unwrap_err(), code(0, E::AlreadySettled));
}

#[test]
fn recording_a_prefix_pays_nobody_and_is_idempotent() {
    let mut w = world();
    let chain = w.two_spends();
    let watched = [
        w.payee_token,
        escrow_address(&w.issuer.lock),
        ledger_address(&w.issuer.lock),
        w.holder.wallet_token,
    ];
    let before = w.env.digest(&watched);
    w.record(&chain.prefix(1), 0).unwrap();
    assert_eq!(
        w.env.digest(&watched),
        before,
        "no token moved and the ledger is untouched"
    );
    let lamports = w.env.lamports(&w.env.payer.pubkey());
    // A second time: everything is already on record, nothing is created, only the fee is paid.
    w.record(&chain.prefix(1), 2).unwrap();
    assert_eq!(lamports - w.env.lamports(&w.env.payer.pubkey()), 5_000);
}

#[test]
fn recording_a_prefix_is_refused_after_its_window_and_at_the_end_of_the_lock() {
    let mut w = world();
    let chain = w.two_spends();
    let prefix = chain.prefix(1);
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE) + 1);
    assert_eq!(
        w.record(&prefix, 0).unwrap_err(),
        code(1, E::SettlementClosed)
    );
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE));
    w.record(&prefix, 0).unwrap();
    let mut w = world();
    let chain = w.two_spends();
    w.env.warp(i64::from(w.issuer.lock_until));
    assert_eq!(
        w.record(&chain.prefix(1), 0).unwrap_err(),
        code(1, E::LockEnded)
    );
    assert!(w.env.spent(&consumed_outputs(&chain)[0]).is_none());
}

#[test]
fn recording_needs_at_least_one_spend_and_at_most_seven() {
    let mut w = world();
    let payer = w.env.payer.pubkey();
    let none = w.issue();
    let signatures = [none.signed[0].signature];
    let ixs = vec![
        precompile_ix(&none.entries(), &signatures),
        record_prefix_ixs(&payer, &w.issuer, &none, 0)
            .pop()
            .unwrap(),
    ];
    assert_eq!(w.send(&ixs).unwrap_err(), code(1, E::TooManySpends));
    let mut eight = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        90_000_000,
        w.holder.key.owner(),
        caveats(w.expiry, 12),
    );
    for i in 0..8 {
        eight = eight.spend2(
            &w.holder.key,
            if i == 0 { 0 } else { 1 },
            Owner::Account(Pubkey::new_unique().to_bytes()),
            1_000_000,
            0,
            i as u8,
        );
    }
    let sigs: Vec<[u8; 64]> = eight.signed[..8].iter().map(|s| s.signature).collect();
    let ixs = vec![
        precompile_ix(&eight.entries()[..8], &sigs),
        record_prefix_ixs(&payer, &w.issuer, &eight, 1)
            .pop()
            .unwrap(),
    ];
    assert_eq!(w.send(&ixs).unwrap_err(), code(1, E::TooManySpends));
}

#[test]
fn a_wrong_record_account_is_refused_before_anything_is_skipped() {
    // A record account that is not the output's address is refused before anything is skipped.
    let mut w = world();
    let chain = w.two_spends();
    w.record(&chain.prefix(1), 0).unwrap();
    let payer = w.env.payer.pubkey();
    let mut ixs = settle_ixs_resumed(&w.env, &payer, &w.issuer, &chain, &w.payee_token, 2);
    let last = ixs.len() - 1;
    let records = ixs[last].accounts.len();
    ixs[last].accounts[records - 1].pubkey = Pubkey::new_from_array([9; 32]);
    ixs[last].accounts[records - 2].pubkey = Pubkey::new_from_array([8; 32]);
    assert_eq!(
        w.send(&ixs).unwrap_err(),
        code(last as u8, E::RecordAccounts)
    );
}

#[test]
fn each_record_keeps_the_expiry_and_the_retention_of_its_own_output() {
    let mut w = world();
    let child_expiry = expiry_of(&w.env, 3);
    let chain = w
        .issue()
        .spend(&w.holder.key, 0, |c| Spend {
            input: c.id,
            lock_seq: 0,
            salt: [7; 16],
            outputs: Outputs::One {
                owner: w.second.key.owner(),
                caveats: Caveats {
                    expiry: child_expiry,
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
            },
        })
        .spend1_to_account(&w.second.key, 0, &w.payee, NO_LOCK, 8);
    w.settle(&chain, 0).unwrap();
    let outputs = consumed_outputs(&chain);
    for (output, expiry) in [(outputs[0], w.expiry), (outputs[1], child_expiry)] {
        let record = w.env.spent(&output).unwrap();
        assert_eq!(record.expiry, expiry);
        assert_eq!(
            u64::from(record.closable_at),
            buckspay_protocol::window::closable_at(expiry, w.issuer.lock_until)
        );
    }
    let parent = w.env.spent(&outputs[0]).unwrap().closable_at;
    let child = w.env.spent(&outputs[1]).unwrap().closable_at;
    assert!(
        parent > child,
        "an ancestor is kept longer than its descendant"
    );
}
