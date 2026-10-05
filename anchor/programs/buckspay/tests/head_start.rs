//! The order of the two reclaims of a paid output, and what a third party can do to a reclaim.
//!
//! A payment to a device expires `EXPIRY_STEP` before the output it spends, so the payee's reclaim
//! opens that long before the spender's reclaim of the output it paid with. Without the step a
//! spender could give the child the parent's expiry, reclaim at `E + GRACE + 1` what it had
//! already paid, and the payee's later reclaim would fail with 6030.
mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::BuckspayError as E;
use buckspay_protocol::{
    chain,
    hash::{message_id, output_id},
    lock::EXPIRY_STEP,
    window::{closable_at, reclaim_opens},
    Caveats, Outputs, Spend, GRACE,
};
use common::*;
use solana_account::Account;
use solana_signer::Signer;
use solana_transaction::TransactionError;

const AMOUNT: u64 = 50_000_000;
const BACKING: u64 = 1_000_000_000;

#[derive(Clone, Copy)]
enum Who {
    Spender,
    Payee,
}

struct W {
    env: Env,
    issuer: Issuer,
    /// Owns the issue and spends it: the spender.
    spender: Issuer,
    /// Receives the payment on a device: the payee.
    payee: Issuer,
    expiry: u32,
}

fn world() -> W {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, BACKING, 60);
    let spender = env.issuer(2, 1_000_000, 10_000_000, 60);
    let payee = env.issuer(3, 1_000_000, 10_000_000, 60);
    let expiry = expiry_of(&env, 10);
    W {
        env,
        issuer,
        spender,
        payee,
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
            self.spender.key.owner(),
            caveats(self.expiry, 6),
        )
    }

    /// The spender pays the payee's device an output that expires at `child_expiry`.
    fn paid(&self, child_expiry: u32, raw: bool) -> Chain {
        let spend = |c: &chain::Output| Spend {
            input: c.id,
            lock_seq: 0,
            salt: [7; 16],
            outputs: Outputs::One {
                owner: self.payee.key.owner(),
                caveats: Caveats {
                    expiry: child_expiry,
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
            },
        };
        if raw {
            // Not adjusted and not checked: a spender who ignores the step. The rules refuse the hop,
            // so the id of its output is computed here, and the salt is the first that makes it
            // recordable.
            let mut chain = self.issue().spend_raw(&self.spender.key, 0, |c| {
                (0u16..)
                    .map(|n| Spend {
                        salt: salted([7; 16], n),
                        ..spend(c)
                    })
                    .find(|s| {
                        let (_, env) =
                            chain::spend_signing(&buckspay::note_domain(), c, s).unwrap();
                        recordable(&output_id(&message_id(&env), 0))
                    })
                    .unwrap()
            });
            let input = chain.last.first;
            let link = chain.links.last().unwrap();
            let s = Spend::decode(input.id, &link.body).unwrap();
            let (_, env) = chain::spend_signing(&buckspay::note_domain(), &input, &s).unwrap();
            chain.last = chain::Holding {
                first: chain::Output {
                    id: output_id(&message_id(&env), 0),
                    owner: self.payee.key.owner(),
                    amount: AMOUNT,
                    caveats: Caveats {
                        expiry: child_expiry,
                        hops_left: input.caveats.hops_left - 1,
                        ..input.caveats
                    },
                },
                second: None,
            };
            chain
        } else {
            self.issue().spend(&self.spender.key, 0, spend)
        }
    }

    fn at(&mut self, unix: i64) {
        self.env.warp(unix);
        self.env.svm.expire_blockhash();
    }

    fn reclaim(&mut self, chain: &Chain, who: Who) -> Result<Landed, TransactionError> {
        let payer = self.env.payer.pubkey();
        let owner = match who {
            Who::Spender => &self.spender,
            Who::Payee => &self.payee,
        };
        let ixs = reclaim_ixs(
            &self.env,
            &payer,
            &self.issuer,
            chain,
            0,
            &owner.key,
            &owner.wallet_token,
        );
        self.env.submit(&ixs)
    }
}

#[test]
fn a_payment_that_does_not_step_down_can_be_neither_reclaimed_nor_settled() {
    let mut w = world();
    let equal = w.paid(w.expiry, true);
    w.at(i64::from(w.expiry) + i64::from(GRACE) + 1);
    // The chain is not a chain any more, so there is no race to win: nothing of it is recorded or
    // paid.
    assert_eq!(
        w.reclaim(&equal, Who::Payee).unwrap_err(),
        code(1, E::ChainInvalid)
    );
    let payee = Pubkey::new_unique();
    let destination = w.env.token_account_of(&payee, 0);
    let chain = equal.spend1_to_account(&w.payee.key, 0, &payee, buckspay_protocol::NO_LOCK, 9);
    let payer = w.env.payer.pubkey();
    let ixs = settle_ixs(&w.env, &payer, &w.issuer, &chain, &destination);
    w.env.svm.expire_blockhash();
    assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::ChainInvalid));
    assert_eq!(w.env.balance(&destination), 0);
}

#[test]
fn the_payee_reclaims_in_its_head_start_and_the_spender_is_refused() {
    let mut w = world();
    let child = w.expiry - EXPIRY_STEP;
    let paid = w.paid(child, false);
    let (payee_opens, spender_opens) = (reclaim_opens(child), reclaim_opens(w.expiry));
    assert_eq!(spender_opens - payee_opens, u64::from(EXPIRY_STEP));
    // The payee's window is open, the spender's is not.
    w.at(payee_opens as i64);
    let issue = w.issue();
    assert_eq!(
        w.reclaim(&issue, Who::Spender).unwrap_err(),
        code(1, E::ReclaimTooEarly)
    );
    w.reclaim(&paid, Who::Payee).unwrap();
    assert_eq!(w.env.balance(&w.payee.wallet_token), AMOUNT);
    // When the spender's window opens the record of its output holds the payment it signed.
    w.at(spender_opens as i64);
    assert_eq!(
        w.reclaim(&issue, Who::Spender).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.balance(&w.spender.wallet_token), 0);
    assert_eq!(w.env.balance(&w.payee.wallet_token), AMOUNT);
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, BACKING - AMOUNT);
}

/// What a loss claim against the spender's bond does not cover, pinned: a payee that neither settled nor reclaimed in
/// the `EXPIRY_STEP` seconds before the spender's window opened loses the output to the spender.
#[test]
fn a_payee_that_misses_its_head_start_loses_to_the_spender() {
    let mut w = world();
    let paid = w.paid(w.expiry - EXPIRY_STEP, false);
    w.at(reclaim_opens(w.expiry) as i64);
    let issue = w.issue();
    w.reclaim(&issue, Who::Spender).unwrap();
    assert_eq!(w.env.balance(&w.spender.wallet_token), AMOUNT);
    w.env.svm.expire_blockhash();
    assert_eq!(
        w.reclaim(&paid, Who::Payee).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.balance(&w.payee.wallet_token), 0);
}

/// Accepted: anyone who holds the owner's signed spend can record it as
/// an unpaid prefix, and a record with a spend's content stops the owner's reclaim. The stranger
/// pays 1,061,720 lamports of rent (returned) and gains nothing; the owner loses at most the
/// output, which the issuer takes back at `withdraw_lock`. A reclaim that overrides an unpaid
/// prefix would have to rewrite a record that is the evidence of a double spend.
#[test]
fn a_prefix_recorded_by_anyone_stops_the_owners_reclaim() {
    let mut w = world();
    let paid = w.paid(w.expiry - EXPIRY_STEP, false);
    let payer = w.env.payer.pubkey();
    w.at(i64::from(w.expiry) + i64::from(GRACE));
    w.env
        .submit(&record_prefix_ixs(&payer, &w.issuer, &paid, 0))
        .unwrap();
    w.at(i64::from(w.expiry) + i64::from(GRACE) + 1);
    let issue = w.issue();
    assert_eq!(
        w.reclaim(&issue, Who::Spender).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.balance(&w.spender.wallet_token), 0);
    assert_eq!(
        w.env.ledger(&w.issuer.lock).backing_left,
        BACKING,
        "nobody was paid"
    );
}

#[test]
fn a_reclaimed_output_keeps_its_own_expiry_and_retention() {
    let mut w = world();
    let child = w.expiry - 3 * DAY;
    let paid = w.paid(child, false);
    w.at(reclaim_opens(child) as i64);
    w.reclaim(&paid, Who::Payee).unwrap();
    let record = w.env.spent(&paid.last.first.id).unwrap();
    assert_eq!(record.expiry, child, "not the issue's expiry");
    assert_eq!(
        u64::from(record.closable_at),
        closable_at(child, w.issuer.lock_until)
    );
    let parent = w.env.spent(&consumed_outputs(&paid)[0]).unwrap();
    assert_eq!(parent.expiry, w.expiry);
    assert_eq!(
        u64::from(parent.closable_at),
        closable_at(w.expiry, w.issuer.lock_until)
    );
}

/// The check that an empty record account is empty is not what keeps a settlement from landing on
/// an occupied address: the system program refuses to allocate it. Either check alone leaves the
/// outcome the same, so removing the first one is not a change anyone can observe.
#[test]
fn a_non_empty_system_account_at_a_record_address_stops_the_settlement_whatever_checks_it() {
    let mut w = world();
    let payee = Pubkey::new_unique();
    let destination = w.env.token_account_of(&payee, 0);
    let chain =
        w.issue()
            .spend1_to_account(&w.spender.key, 0, &payee, buckspay_protocol::NO_LOCK, 9);
    let address = spent_address(&consumed_outputs(&chain)[0]);
    w.env
        .svm
        .set_account(
            address,
            Account {
                lamports: w.env.rent(4),
                data: vec![1, 2, 3, 4],
                owner: solana_sdk_ids::system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let before = w.env.digest(&[address, escrow_address(&w.issuer.lock)]);
    let payer = w.env.payer.pubkey();
    let ixs = settle_ixs(&w.env, &payer, &w.issuer, &chain, &destination);
    assert!(w.env.submit(&ixs).is_err());
    assert_eq!(
        w.env.digest(&[address, escrow_address(&w.issuer.lock)]),
        before
    );
    assert_eq!(w.env.balance(&destination), 0);
}
