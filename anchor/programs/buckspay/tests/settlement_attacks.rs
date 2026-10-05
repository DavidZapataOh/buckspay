mod common;
use anchor_lang::{prelude::Pubkey, solana_program::instruction::AccountMeta};
use buckspay::BuckspayError as E;
use buckspay_protocol::{
    flags, lock::RECORD_TTL, window, Caveats, Outputs, Owner, ScopeKind, Spend, GRACE, NO_LOCK,
};
use common::*;
use solana_signer::Signer;
use solana_transaction::TransactionError;

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
    fn issue(&self) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            0,
            AMOUNT,
            self.holder.owner(),
            caveats(self.expiry, 4),
        )
    }
    fn single_hop(&self) -> Chain {
        self.issue()
            .spend1_to_account(&self.holder, 0, &self.payee, NO_LOCK, 1)
    }
    fn ixs(&self, chain: &Chain) -> Vec<anchor_lang::solana_program::instruction::Instruction> {
        settle_ixs(
            &self.env,
            &self.env.payer.pubkey(),
            &self.issuer,
            chain,
            &self.payee_token,
        )
    }
    fn watched(&self, chain: &Chain) -> Vec<Pubkey> {
        let mut v = vec![
            self.payee_token,
            escrow_address(&self.issuer.lock),
            ledger_address(&self.issuer.lock),
        ];
        v.extend(record_outputs(chain).iter().map(spent_address));
        v
    }
}

#[test]
fn no_single_byte_change_of_the_transaction_lands() {
    let mut w = world();
    let chain = w.single_hop();
    let good = w.ixs(&chain);
    let watched = w.watched(&chain);
    let before = w.env.digest(&watched);
    let mut landed = vec![];
    for (ix_index, ix) in good.iter().enumerate() {
        for at in 0..ix.data.len() {
            let mut ixs = good.clone();
            ixs[ix_index].data[at] ^= 1;
            if w.env.submit(&ixs).is_ok() {
                landed.push((ix_index, at));
            }
            assert_eq!(
                w.env.digest(&watched),
                before,
                "state changed at ({ix_index}, {at})"
            );
        }
    }
    let tried: usize = good.iter().map(|ix| ix.data.len()).sum();
    eprintln!("single-byte mutations tried: {tried}");
    assert!(
        landed.is_empty(),
        "these single-byte mutations landed: {landed:?}"
    );
    w.env.submit(&good).unwrap();
}

#[test]
fn a_precompile_instruction_that_is_not_exactly_the_canonical_one_is_refused() {
    let mut w = world();
    let chain = w.single_hop();
    let good = w.ixs(&chain);
    // The precompile ignores data[1] and trailing bytes; the program must not.
    let mut padded = good.clone();
    padded[0].data[1] = 1;
    assert_eq!(
        w.env.submit(&padded).unwrap_err(),
        code(1, E::ChainVerification)
    );
    let mut trailing = good.clone();
    trailing[0].data.push(0);
    assert_eq!(
        w.env.submit(&trailing).unwrap_err(),
        code(1, E::ChainVerification)
    );
    // No verification at all, a verification of fewer messages, of the same messages twice.
    assert_eq!(
        w.env.submit(&good[1..]).unwrap_err(),
        code(0, E::ChainVerification)
    );
    let partial = precompile_ix(&chain.entries()[..1], &[chain.signed[0].signature]);
    assert_eq!(
        w.env.submit(&[partial, good[1].clone()]).unwrap_err(),
        code(1, E::ChainVerification)
    );
    let both = vec![good[0].clone(), good[0].clone(), good[1].clone()];
    assert_eq!(
        w.env.submit(&both).unwrap_err(),
        code(2, E::ChainVerification)
    );
    // After the settle instruction is too late.
    assert!(w.env.submit(&[good[1].clone(), good[0].clone()]).is_err());
}

#[test]
fn a_high_s_signature_never_reaches_the_program() {
    let mut w = world();
    let mut chain = w.single_hop();
    chain.signed[1].signature = w.holder.high_s(&chain.signed[1].envelope);
    let err = w.env.submit(&w.ixs(&chain)).unwrap_err();
    assert!(
        matches!(err, TransactionError::InstructionError(0, _)),
        "{err:?}"
    );
    assert!(w.env.spent(&consumed_outputs(&chain)[0]).is_none());
}

#[test]
fn a_signature_of_another_key_or_another_purpose_or_another_program_is_refused() {
    let mut w = world();
    let chain = w.single_hop();
    // Signed by a key that does not own the output.
    let thief = Key::new(9);
    let mut forged = chain.clone();
    forged.signed[1].signature = thief.sign(&forged.signed[1].envelope);
    assert!(w.env.submit(&w.ixs(&forged)).is_err());
    forged.signed[1].key = thief.sec1();
    assert_eq!(
        w.env.submit(&w.ixs(&forged)).unwrap_err(),
        code(1, E::ChainVerification)
    );
    // The holder's reclaim-purpose signature over the same output is not a spend.
    let mut other = chain.clone();
    let reclaim = buckspay_protocol::reclaim::reclaim_envelope(
        &buckspay::reclaim_domain(),
        &chain_first_output(&chain).id,
        u32::MAX,
    );
    other.signed[1] = Signed {
        key: w.holder.sec1(),
        envelope: reclaim,
        signature: w.holder.sign(&reclaim),
    };
    assert_eq!(
        w.env.submit(&w.ixs(&other)).unwrap_err(),
        code(1, E::ChainVerification)
    );
    // A note signed for another cluster's domain.
    let mut foreign = chain.clone();
    let d = buckspay_protocol::hash::domain(
        buckspay_protocol::hash::purpose::NOTE,
        &buckspay_protocol::cluster::MAINNET_GENESIS_HASH,
        &buckspay::ID.to_bytes(),
    );
    let mut env = foreign.signed[1].envelope;
    env[..32].copy_from_slice(&d);
    foreign.signed[1].envelope = env;
    foreign.signed[1].signature = w.holder.sign(&env);
    assert_eq!(
        w.env.submit(&w.ixs(&foreign)).unwrap_err(),
        code(1, E::ChainVerification)
    );
}

#[test]
fn the_issue_must_match_the_lock_it_names() {
    let mut w = world();
    // More than the lock backs.
    let over = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        990_000_000,
        20_000_000,
        w.holder.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 1);
    assert_eq!(
        w.env.submit(&w.ixs(&over)).unwrap_err(),
        code(1, E::WrongLock)
    );
    // Another mint than the lock's.
    let other_mint = Pubkey::new_unique();
    let wrong_mint = Chain::issue(
        &w.issuer.key,
        &other_mint,
        0,
        0,
        AMOUNT,
        w.holder.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 1);
    assert_eq!(
        w.env.submit(&w.ixs(&wrong_mint)).unwrap_err(),
        code(1, E::WrongLock)
    );
    // A lock that was never created.
    let missing = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        7,
        0,
        AMOUNT,
        w.holder.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 1);
    assert!(w.env.submit(&w.ixs(&missing)).is_err());
    // Another issuer's key with this lock's accounts.
    let impostor = Key::new(8);
    let forged = Chain::issue(
        &impostor,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        w.holder.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 1);
    assert!(w.env.submit(&w.ixs(&forged)).is_err());
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

#[test]
fn only_the_account_the_note_pays_can_receive_and_the_escrow_never_does() {
    let mut w = world();
    let chain = w.single_hop();
    let stranger = w.env.token_account_of(&Pubkey::new_unique(), 0);
    let ixs = settle_ixs(&w.env, &w.env.payer.pubkey(), &w.issuer, &chain, &stranger);
    assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::WrongPayee));
    let escrow = escrow_address(&w.issuer.lock);
    let ixs = settle_ixs(&w.env, &w.env.payer.pubkey(), &w.issuer, &chain, &escrow);
    assert!(w.env.submit(&ixs).is_err());
    let missing = Pubkey::new_unique();
    let ixs = settle_ixs(&w.env, &w.env.payer.pubkey(), &w.issuer, &chain, &missing);
    assert!(w.env.submit(&ixs).is_err());
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

#[test]
fn a_frozen_destination_fails_cleanly_and_the_note_settles_once_thawed() {
    let mut w = world();
    let chain = w.single_hop();
    w.env.put_token_account(w.payee_token, &w.payee, 0, true);
    let watched = w.watched(&chain);
    let before = w.env.digest(&watched);
    assert!(w.env.submit(&w.ixs(&chain)).is_err());
    assert_eq!(w.env.digest(&watched), before);
    w.env.put_token_account(w.payee_token, &w.payee, 0, false);
    w.env.submit(&w.ixs(&chain)).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
}

#[test]
fn record_accounts_are_checked_one_by_one() {
    let mut w = world();
    let chain = w.single_hop();
    let good = w.ixs(&chain);
    let payer = w.env.payer.pubkey();
    // None, a wrong address, an extra one, a writable-flag downgrade.
    let mut none = good.clone();
    none[1].accounts.pop();
    assert_eq!(w.env.submit(&none).unwrap_err(), code(1, E::RecordAccounts));
    let mut wrong = good.clone();
    wrong[1].accounts.last_mut().unwrap().pubkey = spent_address(&[9; 32]);
    assert_eq!(
        w.env.submit(&wrong).unwrap_err(),
        code(1, E::RecordAccounts)
    );
    let mut extra = good.clone();
    extra[1]
        .accounts
        .push(AccountMeta::new(spent_address(&[9; 32]), false));
    assert_eq!(
        w.env.submit(&extra).unwrap_err(),
        code(1, E::RecordAccounts)
    );
    let mut readonly = good.clone();
    readonly[1].accounts.last_mut().unwrap().is_writable = false;
    assert_eq!(
        w.env.submit(&readonly).unwrap_err(),
        code(1, E::RecordAccounts)
    );
    // The record of a spend that never happened is not the record of this one.
    let _ = payer;
    w.env.submit(&good).unwrap();
}

#[test]
fn prefunding_a_record_address_does_not_stop_the_settlement() {
    let mut w = world();
    let chain = w.single_hop();
    let address = spent_address(&consumed_outputs(&chain)[0]);
    let gift = w.env.rent(81) + 1_000;
    w.env
        .svm
        .set_account(
            address,
            solana_account::Account {
                lamports: gift,
                data: vec![],
                owner: solana_sdk_ids::system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let before = w.env.lamports(&w.env.payer.pubkey());
    w.env.submit(&w.ixs(&chain)).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
    assert_eq!(
        before - w.env.lamports(&w.env.payer.pubkey()),
        5_000 * 2 + 5_000,
        "the payer pays only fees: the gift covered the rent"
    );
    assert_eq!(w.env.lamports(&address), gift);
}

#[test]
fn rules_of_the_protocol_are_enforced_on_chain() {
    let mut w = world();
    // NO_LOCK on a payment that is not a settlement.
    let no_lock = w.issue().spend2(
        &w.holder,
        0,
        Owner::Account(w.payee.to_bytes()),
        1_000_000,
        NO_LOCK,
        1,
    );
    assert_eq!(
        w.env.submit(&w.ixs(&no_lock)).unwrap_err(),
        code(1, E::ChainInvalid)
    );
    // A child that outlives its parent.
    let longer = w.issue().spend(&w.holder, 0, |c| Spend {
        input: c.id,
        lock_seq: NO_LOCK,
        salt: [3; 16],
        outputs: Outputs::One {
            owner: Owner::Account(w.payee.to_bytes()),
            caveats: Caveats {
                expiry: w.expiry + 1,
                hops_left: 3,
                ..c.caveats
            },
        },
    });
    assert_eq!(
        w.env.submit(&w.ixs(&longer)).unwrap_err(),
        code(1, E::ChainInvalid)
    );
    // A merchant-scoped note paid to another account.
    let scoped = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        w.holder.owner(),
        Caveats {
            expiry: w.expiry,
            hops_left: 4,
            flags: 0,
            scope_kind: ScopeKind::Merchant,
            scope: Owner::Account([5; 32]).scope_hash(),
        },
    )
    .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 1);
    assert_eq!(
        w.env.submit(&w.ixs(&scoped)).unwrap_err(),
        code(1, E::ChainInvalid)
    );
    // A delegated output paid out with no lock of the spender is fine only when it is a settlement.
    let delegated = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        w.holder.owner(),
        Caveats {
            expiry: w.expiry,
            hops_left: 4,
            flags: flags::DELEGATED,
            scope_kind: ScopeKind::Any,
            scope: [0; 20],
        },
    )
    .spend(&w.holder, 0, |c| Spend {
        input: c.id,
        lock_seq: NO_LOCK,
        salt: [1; 16],
        outputs: Outputs::One {
            owner: Owner::Account(w.payee.to_bytes()),
            caveats: Caveats {
                hops_left: 3,
                flags: 0,
                ..c.caveats
            },
        },
    });
    w.env.submit(&w.ixs(&delegated)).unwrap();
    // A payment to a device is not a settlement.
    let to_device = w.issue().spend(&w.holder, 0, |c| Spend {
        input: c.id,
        lock_seq: 0,
        salt: [4; 16],
        outputs: Outputs::One {
            owner: Key::new(5).owner(),
            caveats: Caveats {
                hops_left: 3,
                ..c.caveats
            },
        },
    });
    assert_eq!(
        w.env.submit(&w.ixs(&to_device)).unwrap_err(),
        code(1, E::ChainInvalid)
    );
}

#[test]
fn an_over_issued_backing_pays_the_first_and_refuses_the_rest_without_a_trace() {
    let mut w = world();
    let a = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        600_000_000,
        w.holder.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 1);
    // Overlapping interval: the issuer signed it twice.
    let b = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        300_000_000,
        600_000_000,
        Key::new(3).owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&Key::new(3), 0, &w.payee, NO_LOCK, 2);
    w.env.submit(&w.ixs(&a)).unwrap();
    let watched = w.watched(&b);
    let before = w.env.digest(&watched);
    assert_eq!(
        w.env.submit(&w.ixs(&b)).unwrap_err(),
        code(1, E::InsufficientEscrow)
    );
    assert_eq!(w.env.digest(&watched), before);
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 400_000_000);
}

fn close_ix(
    address: &Pubkey,
    receiver: &Pubkey,
) -> anchor_lang::solana_program::instruction::Instruction {
    anchor_lang::solana_program::instruction::Instruction {
        program_id: buckspay::ID,
        accounts: vec![
            AccountMeta::new(*address, false),
            AccountMeta::new(*receiver, false),
        ],
        data: anchor_lang::InstructionData::data(&buckspay::instruction::CloseSpent {}),
    }
}

#[test]
fn records_close_only_after_the_retention_and_return_their_rent_to_whoever_paid() {
    let mut w = world();
    let chain = w.single_hop();
    w.env.submit(&w.ixs(&chain)).unwrap();
    let address = spent_address(&consumed_outputs(&chain)[0]);
    let closable = window::closable_at(w.expiry, w.issuer.lock_until) as i64;
    assert_eq!(
        closable,
        i64::from(w.expiry) + i64::from(GRACE) + i64::from(RECORD_TTL),
        "the record outlives the output, not the lock"
    );
    assert_eq!(
        w.env
            .spent(&consumed_outputs(&chain)[0])
            .unwrap()
            .closable_at as i64,
        closable
    );
    let payer = w.env.payer.pubkey();
    w.env.warp(closable - 1);
    assert_eq!(
        w.env.submit(&[close_ix(&address, &payer)]).unwrap_err(),
        code(0, E::RecordNotClosable)
    );
    w.env.warp(closable);
    // A stranger cannot redirect the rent.
    let stranger = Pubkey::new_unique();
    assert_eq!(
        w.env.submit(&[close_ix(&address, &stranger)]).unwrap_err(),
        code(0, E::RecordAccounts)
    );
    let before = w.env.lamports(&payer);
    w.env.submit(&[close_ix(&address, &payer)]).unwrap();
    assert_eq!(w.env.lamports(&payer) + 5_000 - before, w.env.rent(81));
    assert!(w.env.spent(&consumed_outputs(&chain)[0]).is_none());
    // With the record gone the note still cannot be settled, and the output cannot be reclaimed:
    // both windows ended before the record could be closed.
    w.env.svm.expire_blockhash();
    assert_eq!(
        w.env.submit(&w.ixs(&chain)).unwrap_err(),
        code(1, E::SettlementClosed)
    );
}

#[test]
fn a_record_is_never_closable_before_the_lock_it_depends_on_has_ended() {
    // The lock ends before the output's windows would: the record is kept until the lock ended
    // and the retention passed, and a settlement is then refused by the lock, not by the window.
    let mut w = world();
    w.expiry = w.issuer.lock_until + 10 * DAY;
    let chain = w.single_hop();
    w.env.submit(&w.ixs(&chain)).unwrap();
    let address = spent_address(&consumed_outputs(&chain)[0]);
    let closable = i64::from(w.issuer.lock_until) + i64::from(RECORD_TTL);
    assert_eq!(
        i64::from(
            w.env
                .spent(&consumed_outputs(&chain)[0])
                .unwrap()
                .closable_at
        ),
        closable
    );
    let payer = w.env.payer.pubkey();
    w.env.warp(closable - 1);
    assert!(w.env.submit(&[close_ix(&address, &payer)]).is_err());
    w.env.warp(closable);
    w.env.submit(&[close_ix(&address, &payer)]).unwrap();
    w.env.svm.expire_blockhash();
    assert_eq!(
        w.env.submit(&w.ixs(&chain)).unwrap_err(),
        code(1, E::LockEnded)
    );
}

#[test]
fn one_closed_record_does_not_make_a_batch_revert() {
    let mut w = world();
    let c1 = w.single_hop();
    let h2 = Key::new(7);
    let c2 = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        AMOUNT,
        AMOUNT,
        h2.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&h2, 0, &w.payee, NO_LOCK, 2);
    for c in [&c1, &c2] {
        w.env.submit(&w.ixs(c)).unwrap();
        w.env.svm.expire_blockhash();
    }
    let (a1, a2) = (
        spent_address(&consumed_outputs(&c1)[0]),
        spent_address(&consumed_outputs(&c2)[0]),
    );
    let payer = w.env.payer.pubkey();
    w.env
        .warp(window::closable_at(w.expiry, w.issuer.lock_until) as i64);
    w.env.submit(&[close_ix(&a1, &payer)]).unwrap();
    w.env.svm.expire_blockhash();
    let before = w.env.lamports(&payer);
    let batch = anchor_lang::solana_program::instruction::Instruction {
        program_id: buckspay::ID,
        accounts: [a1, a2, a1]
            .iter()
            .flat_map(|a| [AccountMeta::new(*a, false), AccountMeta::new(payer, false)])
            .collect(),
        data: anchor_lang::InstructionData::data(&buckspay::instruction::CloseSpent {}),
    };
    w.env.submit(&[batch]).unwrap();
    assert!(w.env.spent(&consumed_outputs(&c2)[0]).is_none());
    assert_eq!(
        w.env.lamports(&payer) + 5_000 - before,
        w.env.rent(81),
        "the closed record is skipped, the open one is closed once"
    );
}

/// The transaction's precompile instruction is top level; the settlement is called through a
/// program that forwards its data. The program reads the facts from the precompile instruction and
/// binds the bodies to them by hash, so the wrapper changes nothing in either direction.
#[test]
fn a_cpi_wrapper_gains_nothing() {
    let mut w = world();
    let attacker = Pubkey::new_unique(); // the forwarding program
    w.env.svm.add_program(attacker, &forwarder()).unwrap();
    let wrap = |ix: &anchor_lang::solana_program::instruction::Instruction| {
        let mut accounts = ix.accounts.clone();
        accounts.push(AccountMeta::new_readonly(buckspay::ID, false));
        anchor_lang::solana_program::instruction::Instruction {
            program_id: attacker,
            accounts,
            data: [buckspay::ID.to_bytes().to_vec(), ix.data.clone()].concat(),
        }
    };
    let a = w.single_hop();
    let b = w
        .issue()
        .spend1_to_account(&w.holder, 0, &w.payee, NO_LOCK, 9);
    // The verification of chain A with the settlement of chain B: refused.
    let (va, vb) = (w.ixs(&a), w.ixs(&b));
    let err = w.env.submit(&[va[0].clone(), wrap(&vb[1])]).unwrap_err();
    assert_eq!(err, code(1, E::ChainVerification));
    assert_eq!(w.env.balance(&w.payee_token), 0);
    // The honest data through the wrapper behaves like the direct call: paid once.
    w.env.submit(&[va[0].clone(), wrap(&va[1])]).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
    w.env.svm.expire_blockhash();
    assert_eq!(
        w.env.submit(&[va[0].clone(), wrap(&va[1])]).unwrap_err(),
        code(1, E::AlreadySettled)
    );
}
