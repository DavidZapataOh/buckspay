mod common;
use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use common::*;

const DAY: u32 = 24 * 60 * 60;
/// The signatures an onboarding transaction pays for: the sponsor's, the wallet's and the device
/// key's, which the secp256r1 precompile verifies.
const SIGNATURES: u64 = 3;

#[test]
fn create_lock_funds_the_escrow_and_records_exactly_the_ticket_fields() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let until = env.now() + MIN_LOCK + DAY;
    let lock = lock_for(&mut env, &user, 20_000_000, 100_000_000, MIN_LOCK + DAY);

    let record: buckspay::state::Lock = env.account(&lock.address);
    assert_eq!(record.mint, env.mint);
    assert_eq!(
        (record.bond, record.backing, record.lock_until),
        (20_000_000, 100_000_000, until)
    );
    let ledger = env.ledger(&lock.address);
    assert_eq!(
        (ledger.backing_left, ledger.bond_free, ledger.bond_slashed),
        (100_000_000, 20_000_000, 0)
    );
    assert_eq!(
        (ledger.payer, ledger.key, ledger.lock_seq, ledger.withdrawn),
        (user.wallet.pubkey(), user.key.sec1(), 0, false)
    );
    assert_eq!(env.svm.get_account(&lock.address).unwrap().data.len(), 62);
    assert_eq!(env.svm.get_account(&lock.ledger).unwrap().data.len(), 103);

    assert_eq!(env.balance(&lock.escrow), 120_000_000);
    assert_eq!(env.balance(&user.token), 880_000_000);
    assert_eq!(env.device(&user.key.sec1()).next_lock_seq, 1);
    let escrow = env.token_account(&lock.escrow);
    assert_eq!((escrow.mint, escrow.owner), (env.mint, lock.ledger));
    assert!(escrow.delegate.is_none() && escrow.close_authority.is_none());
}

#[test]
fn a_lock_stores_the_canonical_bump_of_its_escrow() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let lock = lock_for(&mut env, &user, 20_000_000, 100_000_000, MIN_LOCK + DAY);
    let (escrow, bump) = Pubkey::find_program_address(
        &[buckspay::ESCROW_SEED, lock.address.as_ref()],
        &buckspay::ID,
    );
    assert_eq!(escrow, lock.escrow);
    let record: buckspay::state::Lock = env.account(&lock.address);
    assert_eq!(record.escrow_bump, bump);
}

#[test]
fn onboarding_is_one_atomic_transaction_paid_entirely_by_the_sponsor() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000_000_000); // 0 lamports, 1,000 tokens, no Device
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let ixs = onboard_ixs(
        &env,
        &user,
        &s,
        args_for(&user, 0, 20_000_000, 100_000_000, until),
        None,
    );
    let before = env.lamports(&s);

    let landed = env
        .send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();

    assert!(
        landed.size <= 1_100,
        "the onboarding transaction is {} bytes",
        landed.size
    );
    let key = user.key.sec1();
    assert_eq!(env.device(&key).wallet, user.wallet.pubkey());
    assert_eq!(env.device(&key).next_lock_seq, 1);
    let lock = Lock::at(&user, 0, 20_000_000, 100_000_000, until);
    assert_eq!(env.balance(&lock.escrow), 120_000_000);
    assert_eq!(
        env.svm
            .get_account(&user.wallet.pubkey())
            .map_or(0, |a| a.lamports),
        0,
        "the wallet never touches SOL"
    );
    // Device 49 B + Lock 62 + Ledger 103 + escrow 165 rents, plus the two transaction signatures
    // and the secp256r1 verification's, which the fee counts too.
    let rents = env.rent(49) + env.rent(62) + env.rent(103) + env.rent(165);
    assert_eq!(before - env.lamports(&s), rents + SIGNATURES * 5_000);
}

#[test]
fn a_wallet_that_cannot_fund_the_lock_leaves_no_registration_and_costs_only_the_fee() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(119_999_999); // one base unit short
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let ixs = onboard_ixs(
        &env,
        &user,
        &s,
        args_for(&user, 0, 20_000_000, 100_000_000, until),
        None,
    );
    let (before, snap) = (env.lamports(&s), env.snapshot());

    let err = env
        .send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap_err();

    assert!(
        matches!(err, TransactionError::InstructionError(2, _)),
        "the funding leg fails: {err:?}"
    );
    assert_eq!(env.snapshot(), snap, "no Device, no Lock, no escrow");
    assert!(env
        .svm
        .get_account(&lock_address(&user.key.sec1(), 0))
        .is_none());
    assert_eq!(
        before - env.lamports(&s),
        SIGNATURES * 5_000,
        "the sponsor lost one transaction fee and nothing else"
    );
}

#[test]
fn the_funder_cannot_serve_two_onboardings_with_the_same_tokens() {
    let mut env = Env::new(TokenKind::Classic);
    let a = env.unregistered_user(120_000_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    // A second key bound to the same wallet and token account.
    let b = a.with_key(DeviceKey::new(0x42));
    let first = onboard_ixs(
        &env,
        &a,
        &s,
        args_for(&a, 0, 20_000_000, 100_000_000, until),
        None,
    );
    let second = onboard_ixs(
        &env,
        &b,
        &s,
        args_for(&b, 0, 20_000_000, 100_000_000, until),
        None,
    );
    env.send_signed(&s, &first, &[&env.sponsor.insecure_clone(), &a.wallet])
        .unwrap();
    let err = env
        .send_signed(&s, &second, &[&env.sponsor.insecure_clone(), &a.wallet])
        .unwrap_err();
    assert!(matches!(err, TransactionError::InstructionError(2, _)));
    assert!(
        env.svm
            .get_account(&device_address(&b.key.sec1()))
            .is_none(),
        "the second key is not registered"
    );
}

#[test]
fn lock_seq_must_be_the_devices_next_one_and_never_the_reserved_value() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let w = user.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    for wrong in [1, 5, u32::MAX] {
        let ix = create_lock_ix(&env, &user, &w, args_for(&user, wrong, 1, 1, until), None);
        let before = env.snapshot();
        let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
        let expected = if wrong == u32::MAX {
            BuckspayError::LockSeqExhausted
        } else {
            BuckspayError::LockSeqMismatch
        };
        assert_eq!(err, program_error(0, 6000 + expected as u32), "seq {wrong}");
        assert_eq!(
            env.snapshot(),
            before,
            "a refused create_lock changes nothing"
        );
    }
    let ok = create_lock_ix(&env, &user, &w, args_for(&user, 0, 1, 1, until), None);
    env.send_signed(&w, std::slice::from_ref(&ok), &[&user.wallet])
        .unwrap();
    env.svm.expire_blockhash();
    assert!(
        env.send_signed(&w, &[ok], &[&user.wallet]).is_err(),
        "replay of seq 0"
    );
}

#[test]
fn the_counter_stops_before_the_reserved_value() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let w = user.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    env.edit_device(&user.key.sec1(), |d| d.next_lock_seq = NO_LOCK - 1);
    let last = create_lock_ix(
        &env,
        &user,
        &w,
        args_for(&user, NO_LOCK - 1, 1, 1, until),
        None,
    );
    env.send_signed(&w, &[last], &[&user.wallet]).unwrap();
    assert_eq!(env.device(&user.key.sec1()).next_lock_seq, NO_LOCK);
    let beyond = create_lock_ix(&env, &user, &w, args_for(&user, NO_LOCK, 1, 1, until), None);
    let err = env.send_signed(&w, &[beyond], &[&user.wallet]).unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::LockSeqExhausted as u32)
    );
}

#[test]
fn lock_until_is_bounded_on_both_sides_to_the_second() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let w = user.wallet.pubkey();
    let now = env.now();
    for (until, ok) in [
        (now + MIN_LOCK - 1, false),
        (now + MAX_LOCK + 1, false),
        (now + MIN_LOCK, true),
        (now + MAX_LOCK, true),
    ] {
        let seq = env.device(&user.key.sec1()).next_lock_seq;
        let ix = create_lock_ix(&env, &user, &w, args_for(&user, seq, 1, 1, until), None);
        let r = env.send_signed(&w, &[ix], &[&user.wallet]);
        assert_eq!(r.is_ok(), ok, "until = now + {}", until - now);
        if !ok {
            let code = if until < now + MIN_LOCK {
                BuckspayError::LockTooShort
            } else {
                BuckspayError::LockTooLong
            };
            assert_eq!(r.unwrap_err(), program_error(0, 6000 + code as u32));
        }
    }
}

#[test]
fn amounts_are_checked_for_zero_overflow_and_funds() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let w = user.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    for (bond, backing, err) in [
        (0, 0, BuckspayError::AmountZero),
        (u64::MAX, 1, BuckspayError::AmountOverflow),
        (
            u64::MAX / 2 + 1,
            u64::MAX / 2 + 1,
            BuckspayError::AmountOverflow,
        ),
    ] {
        let ix = create_lock_ix(
            &env,
            &user,
            &w,
            args_for(&user, 0, bond, backing, until),
            None,
        );
        assert_eq!(
            env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
            program_error(0, 6000 + err as u32)
        );
    }
    let before = env.snapshot();
    let ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 600, 600, until), None);
    assert!(env.send_signed(&w, &[ix], &[&user.wallet]).is_err());
    assert_eq!(env.snapshot(), before);
    for (bond, backing) in [(10, 0), (0, 10)] {
        // a re-spender needs a bond and issues nothing
        let seq = env.device(&user.key.sec1()).next_lock_seq;
        let ix = create_lock_ix(
            &env,
            &user,
            &w,
            args_for(&user, seq, bond, backing, until),
            None,
        );
        env.send_signed(&w, &[ix], &[&user.wallet]).unwrap();
    }
}

#[test]
fn the_fee_lever_works_only_on_the_first_lock_of_a_sponsored_onboarding_and_is_capped() {
    let mut env = Env::new(TokenKind::Classic);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let spons = Some(env.sponsor_token);
    let user = env.unregistered_user(1_000_000_000);
    let sign =
        |env: &Env, user: &User| vec![env.sponsor.insecure_clone(), user.wallet.insecure_clone()];

    // Refused: above a quarter of the funds; above one whole token; no recipient.
    for (fee, st, err) in [
        (50_000_001, spons, BuckspayError::FeeTooHigh),
        (1, None, BuckspayError::FeeNotAllowed),
    ] {
        let mut a = args_for(&user, 0, 50_000_000, 150_000_000, until);
        a.sponsor_fee = fee;
        let ixs = onboard_ixs(&env, &user, &s, a, st);
        let keys = sign(&env, &user);
        let r = env.send_signed(&s, &ixs, &keys.iter().collect::<Vec<_>>());
        assert_eq!(r.unwrap_err(), program_error(2, 6000 + err as u32));
    }
    let big = env.unregistered_user(100_000_000_000); // 100,000 tokens: a quarter is 25,000, the absolute cap is 1
    let mut a = args_for(&big, 0, 20_000_000_000, 30_000_000_000, until);
    a.sponsor_fee = 1_000_001; // one base unit above one whole token (10^6)
    let ixs = onboard_ixs(&env, &big, &s, a, spons);
    let keys = sign(&env, &big);
    assert_eq!(
        env.send_signed(&s, &ixs, &keys.iter().collect::<Vec<_>>())
            .unwrap_err(),
        program_error(2, 6000 + BuckspayError::FeeTooHigh as u32)
    );

    // Allowed: exactly the cap. The wallet pays funds + fee, the sponsor receives the fee.
    let mut a = args_for(&user, 0, 50_000_000, 150_000_000, until);
    a.sponsor_fee = 1_000_000;
    let ixs = onboard_ixs(&env, &user, &s, a, spons);
    let keys = sign(&env, &user);
    env.send_signed(&s, &ixs, &keys.iter().collect::<Vec<_>>())
        .unwrap();
    assert_eq!(
        env.balance(&user.token),
        1_000_000_000 - 200_000_000 - 1_000_000
    );
    assert_eq!(env.balance(&env.sponsor_token), 1_000_000);

    // Second lock of the same key: a fee is refused even from the sponsor.
    let mut a = args_for(&user, 1, 1, 1, until);
    a.sponsor_fee = 1;
    let ix = create_lock_ix(&env, &user, &s, a, spons);
    let keys = sign(&env, &user);
    assert_eq!(
        env.send_signed(&s, &[ix], &keys.iter().collect::<Vec<_>>())
            .unwrap_err(),
        program_error(0, 6000 + BuckspayError::FeeNotAllowed as u32)
    );
}

#[test]
fn a_self_paid_first_lock_cannot_carry_a_fee() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let w = user.wallet.pubkey();
    let mut a = args_for(&user, 0, 100, 100, env.now() + MIN_LOCK + DAY);
    a.sponsor_fee = 1;
    let own_account = env.new_token_account(&w);
    let ix = create_lock_ix(&env, &user, &w, a, Some(own_account));
    assert_eq!(
        env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
        program_error(0, 6000 + BuckspayError::FeeNotAllowed as u32)
    );
}

/// Hostile prefund: every address the onboarding creates already holds the rent minimum plus 1,000
/// lamports as an empty system account (a single lamport is refused by the runtime and proves nothing).
/// The transaction lands and the payer pays only the two signatures.
#[test]
fn prefunded_addresses_do_not_block_onboarding_and_the_excess_returns_to_the_payer() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000_000_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let key = user.key.sec1();
    let lock = Lock::at(&user, 0, 20_000_000, 100_000_000, until);
    for (addr, len) in [
        (device_address(&key), 49),
        (lock.address, 62),
        (lock.ledger, 103),
        (lock.escrow, 165),
    ] {
        let lamports = env.rent(len) + 1_000;
        env.set_account(
            addr,
            Account {
                lamports,
                data: vec![],
                owner: system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        );
    }
    let before = env.lamports(&s);
    let ixs = onboard_ixs(
        &env,
        &user,
        &s,
        args_for(&user, 0, 20_000_000, 100_000_000, until),
        None,
    );
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    assert_eq!(
        before - env.lamports(&s),
        SIGNATURES * 5_000,
        "the attacker paid the rents; the payer paid the signatures"
    );
    for (addr, len) in [
        (device_address(&key), 49),
        (lock.address, 62),
        (lock.ledger, 103),
        (lock.escrow, 165),
    ] {
        let a = env.svm.get_account(&addr).unwrap();
        assert_eq!(a.data.len(), len);
        assert_eq!(
            a.lamports,
            env.rent(len) + 1_000,
            "rent-exempt, excess stays in the account"
        );
    }
}

#[test]
fn the_wallet_must_sign_and_the_key_must_be_registered_to_it() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000_000_000);
    let other = env.user(1_000_000_000);
    let w = other.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    // another registered wallet signs for this key: has_one fails
    let mut ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 1, 1, until), None);
    ix.accounts[0].pubkey = w;
    let err = env.send_signed(&w, &[ix], &[&other.wallet]).unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(2001))
    ); // ConstraintHasOne
       // a key with no Device
    let ghost = env.unregistered_user(10);
    let ix = create_lock_ix(
        &env,
        &ghost,
        &ghost.wallet.pubkey(),
        args_for(&ghost, 0, 1, 1, until),
        None,
    );
    let s = env.sponsor.pubkey();
    let err = env
        .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone(), &ghost.wallet])
        .unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(3012))
    ); // AccountNotInitialized
}

#[test]
fn create_lock_requires_the_wallet_signature() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let mut ix = create_lock_ix(&env, &user, &s, args_for(&user, 0, 1, 1, until), None);
    ix.accounts[0].is_signer = false;
    let before = env.snapshot();
    let err = env
        .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone()])
        .unwrap_err();
    assert_eq!(err, program_error(0, 3010)); // AccountNotSigner
    assert_eq!(env.snapshot(), before);
}

#[test]
fn create_lock_rejects_a_funder_of_another_owner_or_mint() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let other = env.user(1_000);
    let w = user.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    const FUNDER: usize = 7;
    let foreign_mint = env.foreign_token_account(&Pubkey::new_unique(), &w, 1_000);
    for (funder, code) in [(other.token, 2015), (foreign_mint, 2014)] {
        // ConstraintTokenOwner, ConstraintTokenMint
        let mut ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 1, 1, until), None);
        assert_eq!(ix.accounts[FUNDER].pubkey, user.token);
        ix.accounts[FUNDER].pubkey = funder;
        let before = env.snapshot();
        let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
        assert_eq!(err, program_error(0, code));
        assert_eq!(env.snapshot(), before);
    }
}

#[test]
fn create_lock_rejects_a_mint_of_another_token_program_than_passed() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let w = user.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let mut ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 1, 1, until), None);
    let position = ix
        .accounts
        .iter()
        .position(|a| a.pubkey == env.token_program)
        .unwrap();
    ix.accounts[position].pubkey = anchor_spl::token_2022::ID;
    let before = env.snapshot();
    let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
    assert!(
        matches!(
            err,
            TransactionError::InstructionError(0, InstructionError::IncorrectProgramId)
                | TransactionError::InstructionError(0, InstructionError::Custom(2000..=2999))
        ),
        "{err:?}"
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn token2022_plain_and_metadata_pointer_mints_are_accepted() {
    for extensions in [
        vec![],
        vec![ExtensionType::MetadataPointer],
        vec![ExtensionType::MetadataPointer, ExtensionType::TokenMetadata],
    ] {
        let mut env = Env::new_with_mint(MintSetup::token2022(&extensions));
        let user = env.user(1_000);
        let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
        assert_eq!(env.balance(&lock.escrow), 500, "{extensions:?}");
        assert_eq!(env.balance(&user.token), 500);
    }
}

#[test]
fn token2022_mints_with_other_extensions_are_rejected() {
    for extension in [
        ExtensionType::TransferFeeConfig,
        ExtensionType::TransferHook,
        ExtensionType::PermanentDelegate,
        ExtensionType::DefaultAccountState,
        ExtensionType::Pausable,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::NonTransferable,
        ExtensionType::MintCloseAuthority,
    ] {
        let mut env = Env::new_with_mint(MintSetup::token2022(&[extension]));
        let user = env.user(1_000);
        let w = user.wallet.pubkey();
        let until = env.now() + MIN_LOCK + DAY;
        let ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 100, 400, until), None);
        let before = env.snapshot();
        let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
        assert_eq!(
            err,
            program_error(0, 6000 + BuckspayError::UnsupportedMintExtension as u32),
            "{extension:?}"
        );
        assert_eq!(env.snapshot(), before, "{extension:?}");
    }
}

/// A mint that declares 20 or more decimals leaves only the quarter-of-funds cap: the check never
/// aborts on an overflow of `10^decimals`.
#[test]
fn a_mint_with_extreme_decimals_never_aborts_the_fee_check() {
    for decimals in [20, 255] {
        let mut env = Env::new_with_decimals(TokenKind::Classic, decimals);
        let s = env.sponsor.pubkey();
        let until = env.now() + MIN_LOCK + DAY;
        for (fee, expected) in [(101, Some(BuckspayError::FeeTooHigh)), (100, None)] {
            // 400 of funds: a quarter is 100.
            let user = env.unregistered_user(1_000);
            let mut a = args_for(&user, 0, 300, 100, until);
            a.sponsor_fee = fee;
            let ixs = onboard_ixs(&env, &user, &s, a, Some(env.sponsor_token));
            let result = env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet]);
            match expected {
                Some(error) => assert_eq!(
                    result.unwrap_err(),
                    program_error(2, 6000 + error as u32),
                    "{decimals} decimals"
                ),
                None => {
                    result.unwrap();
                    assert_eq!(env.balance(&env.sponsor_token), 100);
                }
            }
        }
    }
}

#[test]
fn create_lock_is_atomic() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(119);
    let until = env.now() + MIN_LOCK + DAY;
    let before = env.snapshot();
    let err = env.try_lock(&user, 20, 100, until).unwrap_err();
    assert_eq!(
        err,
        program_error(0, 1),
        "the token program refuses: insufficient funds"
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn create_lock_with_a_frozen_funder_fails_cleanly() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let until = env.now() + MIN_LOCK + DAY;
    env.freeze(&user.token);
    let before = env.snapshot();
    let err = env.try_lock(&user, 20, 100, until).unwrap_err();
    assert_eq!(err, program_error(0, 17), "AccountFrozen");
    assert_eq!(env.snapshot(), before);
    env.thaw(&user.token);
    env.try_lock(&user, 20, 100, until).unwrap();
}

#[test]
fn onboarding_works_for_token2022_locks() {
    let mut env = Env::new(TokenKind::Token2022);
    let user = env.unregistered_user(1_000_000_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let ixs = onboard_ixs(
        &env,
        &user,
        &s,
        args_for(&user, 0, 20_000_000, 100_000_000, until),
        None,
    );
    let landed = env
        .send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    assert!(landed.size <= 1_100);
    let lock = Lock::at(&user, 0, 20_000_000, 100_000_000, until);
    assert_eq!(env.balance(&lock.escrow), 120_000_000);
    assert_eq!(env.device(&user.key.sec1()).next_lock_seq, 1);
}

/// A destination that demands a memo before every incoming transfer makes a withdrawal fail
/// cleanly: availability only, nothing changes, and a plain destination works.
#[test]
fn sponsored_withdraw_to_a_token2022_destination_with_memo_transfer_fails_cleanly() {
    let mut env = Env::new(TokenKind::Token2022);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    let strict = env.memo_required_token_account(&user.wallet.pubkey());
    let before = env.snapshot();
    let ix = withdraw_ix(&env, &user, &lock, &strict);
    let s = env.sponsor.pubkey();
    let err = env
        .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap_err();
    assert!(
        matches!(
            err,
            TransactionError::InstructionError(0, InstructionError::Custom(_))
        ),
        "{err:?}"
    );
    assert_eq!(env.snapshot(), before);
    let ix = withdraw_ix(&env, &user, &lock, &user.token);
    env.send_signed(&s, &[ix], &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    assert_eq!(env.balance(&user.token), 1_000);
}

/// Wrapped SOL is a token whose account balance follows its lamports, so anyone who sends lamports
/// to the predictable escrow address first would make the funding check fail: it is not accepted.
#[test]
fn the_native_mint_is_refused() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let w = user.wallet.pubkey();
    let native = anchor_spl::token::spl_token::native_mint::ID;
    env.install_classic_mint_at(native);
    let funder = env.foreign_token_account(&native, &w, 500);
    let until = env.now() + MIN_LOCK + DAY;
    let mut ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 100, 400, until), None);
    ix.accounts[6].pubkey = native;
    ix.accounts[7].pubkey = funder;
    let before = env.snapshot();
    let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::UnsupportedMintExtension as u32)
    );
    assert_eq!(env.snapshot(), before);
}
