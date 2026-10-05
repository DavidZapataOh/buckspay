mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::records::{PAID, RECLAIMED};
use buckspay::BuckspayError as E;
use buckspay_protocol::{
    hash::content, lock::RECORD_TTL, reclaim::record_content, Owner, GRACE, NO_LOCK,
};
use common::*;
use solana_signer::Signer;

const AMOUNT: u64 = 50_000_000;

struct World {
    env: Env,
    issuer: Issuer,
    holder: Key,
    payee: Pubkey,
    payee_token: Pubkey,
    expiry: u32,
}

fn world() -> World {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, 1_000_000_000, 60);
    let holder = Key::new(2);
    let payee = Pubkey::new_unique();
    let payee_token = env.token_account_of(&payee, 0);
    let expiry = expiry_of(&env, 10);
    World {
        env,
        issuer,
        holder,
        payee,
        payee_token,
        expiry,
    }
}

impl World {
    fn issue(&self, start: u64, amount: u64) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            start,
            amount,
            self.holder.owner(),
            caveats(self.expiry, 4),
        )
    }
    fn settle(&mut self, chain: &Chain) -> Result<Landed, solana_transaction::TransactionError> {
        let payer = self.env.payer.pubkey();
        let ixs = settle_ixs(&self.env, &payer, &self.issuer, chain, &self.payee_token);
        self.env.submit(&ixs)
    }
    fn single_hop(&self) -> Chain {
        self.issue(0, AMOUNT)
            .spend1_to_account(&self.holder, 0, &self.payee, NO_LOCK, 1)
    }
}

#[test]
fn a_single_hop_note_pays_its_account_and_records_the_spend() {
    let mut w = world();
    let chain = w.single_hop();
    let landed = w.settle(&chain).unwrap();
    eprintln!("single hop: {} CU, {} bytes", landed.units, landed.size);

    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
    assert_eq!(
        w.env.ledger(&w.issuer.lock).backing_left,
        1_000_000_000 - AMOUNT
    );
    assert_eq!(
        w.env.balance(&escrow_address(&w.issuer.lock)),
        1_100_000_000 - AMOUNT
    );
    let consumed = consumed_outputs(&chain);
    assert_eq!(consumed.len(), 1);
    let record = w.env.spent(&consumed[0]).unwrap();
    assert_eq!(record.content, content(&chain.links[0].body));
    assert_eq!((record.flags, record.expiry), (PAID, w.expiry));
    assert_eq!(record.payer, w.env.payer.pubkey());
    assert_eq!(
        u64::from(record.closable_at),
        buckspay_protocol::window::closable_at(w.expiry, w.issuer.lock_until)
    );
    assert_eq!(
        w.env
            .svm
            .get_account(&spent_address(&consumed[0]))
            .unwrap()
            .data
            .len(),
        81
    );
}

#[test]
fn settling_the_same_note_twice_pays_once() {
    let mut w = world();
    let chain = w.single_hop();
    w.settle(&chain).unwrap();
    w.env.svm.expire_blockhash();
    assert_eq!(w.settle(&chain).unwrap_err(), code(1, E::AlreadySettled));
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
}

#[test]
fn a_second_spend_of_the_same_output_is_a_conflict_and_changes_nothing() {
    let mut w = world();
    let first = w.single_hop();
    w.settle(&first).unwrap();
    let other = Pubkey::new_unique();
    let other_token = w.env.token_account_of(&other, 0);
    let second = w
        .issue(0, AMOUNT)
        .spend1_to_account(&w.holder, 0, &other, NO_LOCK, 2);
    let watched = [
        other_token,
        escrow_address(&w.issuer.lock),
        ledger_address(&w.issuer.lock),
        spent_address(&consumed_outputs(&first)[0]),
    ];
    let before = w.env.digest(&watched);
    let payer = w.env.payer.pubkey();
    let ixs = settle_ixs(&w.env, &payer, &w.issuer, &second, &other_token);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.digest(&watched), before);
    assert_eq!(w.env.balance(&other_token), 0);
}

#[test]
fn a_spend2_pays_the_payment_and_its_change_settles_later_through_the_prefix() {
    let mut w = world();
    let merchant = Pubkey::new_unique();
    let merchant_token = w.env.token_account_of(&merchant, 0);
    let second_payee = w.payee;
    // payment of 20 to a device-owned merchant output would be multi-hop; here the payment is a
    // Spend2 whose output 0 is a terminal account.
    let chain = w
        .issue(0, AMOUNT)
        .spend(&w.holder, 0, |c| buckspay_protocol::Spend {
            input: c.id,
            lock_seq: 0,
            salt: [7; 16],
            outputs: buckspay_protocol::Outputs::Two {
                owner0: Owner::Account(merchant.to_bytes()),
                amount0: 20_000_000,
                caveats0: caveats(w.expiry, 3),
                owner1: w.holder.owner(),
            },
        });
    // Settle the change branch first: [issue, spend2, spend1(change)].
    let change = chain
        .clone()
        .spend1_to_account(&w.holder, 1, &second_payee, NO_LOCK, 3);
    w.settle(&change).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), 30_000_000);
    let consumed = consumed_outputs(&change);
    assert_eq!(
        w.env.spent(&consumed[0]).unwrap().flags,
        0,
        "the prefix is recorded unpaid"
    );
    assert_eq!(w.env.spent(&consumed[1]).unwrap().flags, PAID);

    // The payment branch is still payable: [issue, spend2] ends at a terminal account.
    w.env.svm.expire_blockhash();
    let payer = w.env.payer.pubkey();
    let ixs = settle_ixs(&w.env, &payer, &w.issuer, &chain, &merchant_token);
    w.env.submit(&ixs).unwrap();
    assert_eq!(w.env.balance(&merchant_token), 20_000_000);
    assert_eq!(w.env.spent(&consumed[0]).unwrap().flags, PAID);
    assert_eq!(
        w.env.ledger(&w.issuer.lock).backing_left,
        1_000_000_000 - AMOUNT
    );

    w.env.svm.expire_blockhash();
    let again = settle_ixs(&w.env, &payer, &w.issuer, &chain, &merchant_token);
    assert_eq!(
        w.env.submit(&again).unwrap_err(),
        code(1, E::AlreadySettled)
    );
}

#[test]
fn an_issue_to_a_terminal_account_settles_with_no_spend() {
    let mut w = world();
    let chain = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        Owner::Account(w.payee.to_bytes()),
        caveats(w.expiry, 4),
    );
    w.settle(&chain).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
    let key = chain_first_output(&chain).id;
    let record = w.env.spent(&key).unwrap();
    assert_eq!(record.content, content(&chain.issue_body));
    w.env.svm.expire_blockhash();
    assert_eq!(w.settle(&chain).unwrap_err(), code(1, E::AlreadySettled));
}

#[test]
fn settlement_is_open_until_expiry_plus_grace_to_the_second_and_never_at_lock_until() {
    let mut w = world();
    let chain = w.single_hop();
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE) + 1);
    assert_eq!(w.settle(&chain).unwrap_err(), code(1, E::SettlementClosed));
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE));
    w.settle(&chain).unwrap();

    // A note whose expiry lies beyond the lock: refused at lock_until whatever its own window says.
    let mut w = world();
    w.expiry = w.issuer.lock_until + 10 * DAY;
    let chain = w.single_hop();
    w.env.warp(i64::from(w.issuer.lock_until) - 1);
    w.settle(&chain).unwrap();
    let mut w = world();
    w.expiry = w.issuer.lock_until + 10 * DAY;
    let chain = w.single_hop();
    w.env.warp(i64::from(w.issuer.lock_until));
    assert_eq!(w.settle(&chain).unwrap_err(), code(1, E::LockEnded));
}

#[test]
fn reclaim_opens_exactly_when_settlement_closes_and_pays_the_bound_wallet() {
    let mut w = world();
    let chain = w.issue(0, AMOUNT);
    let payer = w.env.payer.pubkey();
    // The owner's device must be registered for the wallet lookup: the issuer's key is.
    let owner = Key::new(1);
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &Chain { ..chain.clone() },
        0,
        &w.holder,
        &w.issuer.wallet_token,
    );
    // The holder (key 2) has no device: refused by the account constraints.
    assert!(w.env.submit(&ixs).is_err());

    // Issue to the issuer's own key: it reclaims into its wallet.
    let own = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        owner.owner(),
        caveats(w.expiry, 4),
    );
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE));
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &own,
        0,
        &owner,
        &w.issuer.wallet_token,
    );
    assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::ReclaimTooEarly));
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE) + 1);
    w.env.svm.expire_blockhash();
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &own,
        0,
        &owner,
        &w.issuer.wallet_token,
    );
    let landed = w.env.submit(&ixs).unwrap();
    eprintln!("reclaim: {} CU, {} bytes", landed.units, landed.size);
    assert_eq!(w.env.balance(&w.issuer.wallet_token), AMOUNT);
    let record = w.env.spent(&chain_first_output(&own).id).unwrap();
    assert_eq!(record.flags, PAID | RECLAIMED);
    assert_eq!(record.content, record_content());

    // Neither a second reclaim nor a settlement of the same output can follow.
    w.env.svm.expire_blockhash();
    let again = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &own,
        0,
        &owner,
        &w.issuer.wallet_token,
    );
    assert_eq!(
        w.env.submit(&again).unwrap_err(),
        code(1, E::AlreadySettled)
    );
}

#[test]
fn a_settled_output_cannot_be_reclaimed_and_a_reclaimed_one_cannot_be_settled() {
    let mut w = world();
    let owner = Key::new(1);
    let payer = w.env.payer.pubkey();
    // Settled first.
    let own = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        owner.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&owner, 0, &w.payee, NO_LOCK, 1);
    w.settle(&own).unwrap();
    // The unspent output of a different issue is reclaimable; the consumed one is not (chain with the
    // spend as a prefix would need a further output, so reclaim the same output through its own chain).
    let plain = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        owner.owner(),
        caveats(w.expiry, 4),
    );
    w.env.warp(i64::from(w.expiry) + i64::from(GRACE) + 1);
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &plain,
        0,
        &owner,
        &w.issuer.wallet_token,
    );
    let err = w.env.submit(&ixs).unwrap_err();
    assert_eq!(err, code(1, E::ConflictingSpend));
    assert_eq!(w.env.balance(&w.issuer.wallet_token), 0);
}

#[test]
fn the_record_is_kept_for_the_output_not_for_the_lock() {
    // Days between the settlement and the second the record may be closed, for a note that
    // expires in `expiry_days` on a lock of `lock_days`.
    let kept = |lock_days: u32, expiry_days: u32| {
        let mut env = Env::new(TokenKind::Classic);
        let issuer = env.issuer(1, 100_000_000, 1_000_000_000, lock_days);
        let holder = Key::new(2);
        let payee = Pubkey::new_unique();
        let token = env.token_account_of(&payee, 0);
        let expiry = expiry_of(&env, expiry_days);
        let chain = Chain::issue(
            &issuer.key,
            &env.mint,
            0,
            0,
            AMOUNT,
            holder.owner(),
            caveats(expiry, 4),
        )
        .spend1_to_account(&holder, 0, &payee, NO_LOCK, 1);
        let payer = env.payer.pubkey();
        env.submit(&settle_ixs(&env, &payer, &issuer, &chain, &token))
            .unwrap();
        let record = env.spent(&consumed_outputs(&chain)[0]).unwrap();
        record.closable_at - env.now()
    };
    // An honest note: 10 days to its expiry, 7 of grace, 14 of retention, whatever the lock.
    let retention = |lock_days: u32, expiry_days: u32| {
        (expiry_days * DAY + GRACE).min(lock_days * DAY) + RECORD_TTL
    };
    for (lock_days, expiry_days) in [(60, 10), (366, 10), (360, 360), (366, 360)] {
        assert_eq!(
            kept(lock_days, expiry_days),
            retention(lock_days, expiry_days)
        );
    }
    // An honest note: 10 days to its expiry, a week of grace, the retention, whatever the lock.
    assert_eq!(kept(60, 10), kept(366, 10));
    #[cfg(not(feature = "short-windows"))]
    {
        assert_eq!(kept(60, 10) / DAY, 31);
        assert_eq!(kept(360, 360) / DAY, 374);
        assert_eq!(kept(366, 360) / DAY, 380);
    }
}
