//! Where the rent of a lock and of a rotation goes when the account that paid it can no longer
//! take lamports: tokens and records must never wait on it.
mod common;
use common::*;
use proptest::prelude::*;

const DAY: u32 = 24 * 60 * 60;
const FEE: u64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Payer {
    /// A system account, as at creation.
    Plain,
    /// Deployed as a program after it paid: the runtime refuses to credit it.
    Executable,
    /// Emptied and closed: it has no account at all.
    Closed,
    /// Owned by another program, with data and fewer lamports than rent exemption asks for.
    RentPaying,
}

impl Payer {
    fn takes_lamports(self) -> bool {
        self != Payer::Executable
    }
}

fn convert_payer(env: &mut Env, address: &Pubkey, state: Payer) {
    match state {
        Payer::Plain => {}
        Payer::Executable => env.make_executable(address),
        Payer::Closed => env.set_account(
            *address,
            Account {
                lamports: 0,
                ..Account::default()
            },
        ),
        Payer::RentPaying => env.set_account(
            *address,
            Account {
                lamports: 1,
                data: vec![0; 200],
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        ),
    }
}

struct Scene {
    env: Env,
    user: User,
    payer: Pubkey,
    lock: Lock,
}

/// A lock paid for by an account other than its wallet, which then becomes `state`.
fn scene(kind: TokenKind, bond: u64, backing: u64, state: Payer) -> Scene {
    let mut env = Env::new(kind);
    let user = env.user(1_000_000);
    let payer = env.funded_keypair();
    let seq = env.device(&user.key.sec1()).next_lock_seq;
    let until = env.now() + MIN_LOCK + DAY;
    let ix = create_lock_ix(
        &env,
        &user,
        &payer.pubkey(),
        args_for(&user, seq, bond, backing, until),
        None,
    );
    env.send_signed(&payer.pubkey(), &[ix], &[&payer, &user.wallet])
        .unwrap();
    let lock = Lock::at(&user, seq, bond, backing, until);
    convert_payer(&mut env, &payer.pubkey(), state);
    Scene {
        env,
        user,
        payer: payer.pubkey(),
        lock,
    }
}

impl Scene {
    /// Every lamport the lock, its payer and the transaction signers hold.
    fn lamports(&self) -> u64 {
        [
            &self.payer,
            &self.user.wallet.pubkey(),
            &self.env.sponsor.pubkey(),
            &self.lock.address,
            &self.lock.ledger,
            &self.lock.escrow,
        ]
        .into_iter()
        .map(|a| self.env.lamports(a))
        .sum()
    }

    fn pay_out(&mut self, release: bool) -> Result<(), TransactionError> {
        let delay = if release { RELEASE_DELAY } else { 0 };
        self.env
            .warp(i64::from(self.lock.until) + i64::from(CLAIM_WINDOW) + i64::from(delay));
        if release {
            self.env.try_release(&self.user, &self.lock)
        } else {
            self.env.try_withdraw(&self.user, &self.user, &self.lock)
        }
    }
}

fn run(kind: TokenKind, bond: u64, backing: u64, state: Payer, release: bool) {
    let mut s = scene(kind, bond, backing, state);
    let tokens = s.env.balance(&s.user.token);
    let supply = s.env.total_supply();
    let payer_start = s.env.lamports(&s.payer);
    let before = s.lamports();

    s.pay_out(release)
        .unwrap_or_else(|e| panic!("{state:?}, release {release}: {e:?}\n{}", s.env.logs()));
    let escrow_rent = s.env.rent(165);
    let ledger_rent = s.env.rent(103);
    let records_rent = s.env.rent(61) + ledger_rent;
    assert_eq!(s.env.balance(&s.user.token), tokens + bond + backing);
    assert_eq!(s.env.total_supply(), supply);
    assert_eq!(
        s.env.lamports(&s.lock.escrow),
        0,
        "the escrow is closed whoever paid it"
    );
    assert!(s.env.ledger(&s.lock.address).withdrawn);
    let forfeited = if state.takes_lamports() {
        0
    } else {
        escrow_rent
    };
    assert_eq!(
        s.env.lamports(&s.payer) - payer_start,
        escrow_rent - forfeited
    );
    assert_eq!(s.env.lamports(&s.lock.ledger), ledger_rent + forfeited);
    let fee = if release { FEE } else { 2 * FEE };
    assert_eq!(s.lamports() + fee, before, "lamports are conserved");

    s.env.warp(i64::from(s.lock.until) + i64::from(RECORD_TTL));
    let before_close = s.lamports();
    s.env
        .try_close(&s.user, &s.lock)
        .unwrap_or_else(|e| panic!("close, {state:?}: {e:?}\n{}", s.env.logs()));
    assert!(
        s.env.svm.get_account(&s.lock.address).is_none()
            && s.env.svm.get_account(&s.lock.ledger).is_none(),
        "the records are gone"
    );
    if state.takes_lamports() {
        assert_eq!(
            s.env.lamports(&s.payer) - payer_start,
            escrow_rent + records_rent
        );
        assert_eq!(s.env.lamports(&s.lock.escrow), 0);
    } else {
        assert_eq!(s.env.lamports(&s.payer), payer_start);
        assert_eq!(
            s.env.lamports(&s.lock.escrow),
            records_rent + escrow_rent,
            "the forfeited rent rests at the dead escrow address"
        );
    }
    assert_eq!(s.lamports() + FEE, before_close, "lamports are conserved");
}

#[test]
fn an_executable_payer_cannot_trap_a_withdrawal_or_a_close() {
    for kind in [TokenKind::Classic, TokenKind::Token2022] {
        run(kind, 100, 400, Payer::Executable, false);
    }
}

#[test]
fn an_executable_payer_cannot_trap_a_release() {
    for kind in [TokenKind::Classic, TokenKind::Token2022] {
        run(kind, 100, 400, Payer::Executable, true);
    }
}

#[test]
fn a_payer_that_can_take_lamports_gets_every_rent_back() {
    for state in [Payer::Plain, Payer::Closed, Payer::RentPaying] {
        for release in [false, true] {
            run(TokenKind::Classic, 100, 400, state, release);
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn whatever_the_payer_becomes_funds_and_rent_are_paid_out_and_lamports_conserved(
        bond in 0u64..=100_000,
        backing in 0u64..=100_000,
        state in prop_oneof![
            Just(Payer::Plain),
            Just(Payer::Executable),
            Just(Payer::Closed),
            Just(Payer::RentPaying),
        ],
        release in any::<bool>(),
        token2022 in any::<bool>(),
    ) {
        prop_assume!(bond + backing > 0);
        let kind = if token2022 { TokenKind::Token2022 } else { TokenKind::Classic };
        run(kind, bond, backing, state, release);
    }
}

#[test]
fn a_wallet_that_paid_for_itself_is_refunded_like_any_payer() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let w = user.wallet.pubkey();
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    let before = env.lamports(&w);
    env.send(
        &user.wallet,
        &[withdraw_ix(&env, &user, &lock, &user.token)],
    )
    .unwrap();
    assert_eq!(env.lamports(&w) + FEE - before, env.rent(165));
}

/// A pending rotation whose payer can no longer take lamports still resolves, and the next one can
/// be requested.
fn rotation(state: Payer, apply: bool) {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(0);
    let payer = env.funded_keypair();
    let new = env.funded_keypair();
    let key = user.key.sec1();
    let device = device_address(&key);
    let t0 = i64::from(env.now());
    let ixs = request_ix(&env, &user, &new.pubkey(), &payer.pubkey(), 0);
    env.send_signed(&payer.pubkey(), &ixs, &[&payer, &new])
        .unwrap();
    convert_payer(&mut env, &payer.pubkey(), state);
    let payer_before = env.lamports(&payer.pubkey());
    let device_before = env.lamports(&device);
    let w = user.wallet.pubkey();

    if apply {
        env.warp(t0 + i64::from(ROTATION_DELAY));
        let ix = apply_ix(&key, &payer.pubkey());
        env.send_signed(&w, &[ix], &[&user.wallet])
            .unwrap_or_else(|e| panic!("apply, {state:?}: {e:?}\n{}", env.logs()));
        assert_eq!(env.device(&key).wallet, new.pubkey());
    } else {
        let ix = cancel_ix(&key, &w, &payer.pubkey());
        env.send_signed(&w, &[ix], &[&user.wallet])
            .unwrap_or_else(|e| panic!("cancel, {state:?}: {e:?}\n{}", env.logs()));
        assert_eq!(env.device(&key).wallet, w);
    }
    assert!(env.svm.get_account(&rotation_address(&key)).is_none());
    let rent = env.rent(77);
    let forfeited = if state.takes_lamports() { 0 } else { rent };
    assert_eq!(
        env.lamports(&payer.pubkey()) - payer_before,
        rent - forfeited
    );
    assert_eq!(env.lamports(&device) - device_before, forfeited);

    let current = if apply { &new } else { &user.wallet };
    let next = env.funded_keypair();
    let ixs = request_ix(&env, &user, &next.pubkey(), &current.pubkey(), 1);
    env.send_signed(&current.pubkey(), &ixs, &[current, &next])
        .expect("the next rotation can be requested");
}

#[test]
fn an_executable_rotation_payer_cannot_block_a_cancel_or_an_apply() {
    for apply in [false, true] {
        rotation(Payer::Executable, apply);
    }
}

#[test]
fn a_rotation_payer_that_can_take_lamports_gets_the_rent_back() {
    for state in [Payer::Plain, Payer::Closed, Payer::RentPaying] {
        for apply in [false, true] {
            rotation(state, apply);
        }
    }
}

#[test]
fn the_refund_cannot_be_redirected_by_claiming_the_payer_is_executable() {
    let mut s = scene(TokenKind::Classic, 100, 400, Payer::Executable);
    let wallet = s.user.wallet.pubkey();
    s.env
        .warp(i64::from(s.lock.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    let before = s.env.snapshot();
    for receiver in [wallet, s.lock.ledger, Pubkey::new_unique()] {
        let ix = release_ix(&s.env, &s.user, &s.lock, &s.user.token, &receiver);
        let sponsor = s.env.sponsor.insecure_clone();
        let err = s
            .env
            .send_signed(&sponsor.pubkey(), &[ix], &[&sponsor])
            .unwrap_err();
        assert_eq!(
            err,
            TransactionError::InstructionError(0, InstructionError::Custom(2012)),
            "ConstraintAddress"
        );
    }
    assert_eq!(s.env.snapshot(), before);
}
