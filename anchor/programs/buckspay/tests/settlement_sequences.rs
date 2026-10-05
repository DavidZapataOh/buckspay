mod common;
use anchor_lang::prelude::Pubkey;
use buckspay_protocol::{
    lock::{EXPIRY_STEP, RECORD_TTL},
    Caveats, Outputs, Owner, Spend, GRACE, NO_LOCK,
};
use common::*;
use proptest::prelude::*;
use solana_signer::Signer;

const ISSUES: usize = 3;
const AMOUNT: u64 = 50_000_000;
const PART: u64 = 30_000_000;
const BACKING: u64 = 1_000_000_000;

/// How much shorter than the issue's the child output of a `Spend1` to a second holder lives:
/// exactly the step, a second more, or anything up to a week. The payee's head start on the
/// spender's reclaim is this long.
fn shorter() -> impl Strategy<Value = u32> {
    prop_oneof![
        Just(EXPIRY_STEP),
        Just(EXPIRY_STEP + 1),
        EXPIRY_STEP..7 * DAY
    ]
}

#[derive(Clone, Copy, Debug)]
enum Step {
    /// Spend1 of the issue's output to payee A.
    A(usize),
    /// A different Spend1 of the same output to payee B (a double spend).
    B(usize),
    /// Spend2 paying X, change kept.
    C(usize),
    /// Spend2 paying X, then the change spent to Y: settles Y, records C as a prefix.
    D(usize),
    /// The output goes to a second holder with a shorter expiry, who spends it to payee F:
    /// the settlement window is the child's, the record of the issue's output is a prefix.
    F(usize),
    /// Only the first hop of F is recorded, nobody is paid: the records of a later F carry on from it.
    P(usize),
    /// The owner reclaims the issue's output.
    ReclaimIssue(usize),
    /// The owner reclaims the change of the Spend2.
    ReclaimChange(usize),
    /// The second holder reclaims the child output it received.
    ReclaimChild(usize),
    /// Time moves forward to a level: 1 closes the child's settlement window, 2 the issue's, 3 ends
    /// the reclaim window of both children and parents.
    Warp(u8),
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        3 => (0..ISSUES).prop_map(Step::A),
        2 => (0..ISSUES).prop_map(Step::B),
        3 => (0..ISSUES).prop_map(Step::C),
        3 => (0..ISSUES).prop_map(Step::D),
        3 => (0..ISSUES).prop_map(Step::F),
        2 => (0..ISSUES).prop_map(Step::P),
        2 => (0..ISSUES).prop_map(Step::ReclaimIssue),
        2 => (0..ISSUES).prop_map(Step::ReclaimChange),
        2 => (0..ISSUES).prop_map(Step::ReclaimChild),
        3 => (1u8..=3).prop_map(Step::Warp),
    ]
}

/// Who consumed an output first, as the protocol defines it: the model does not use the program's
/// own record logic.
#[derive(Clone, Copy, PartialEq, Debug)]
enum By {
    None,
    A,
    B,
    C,
    F,
    ReclaimIssue,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Child {
    Free,
    Paid,
    Reclaimed,
}

#[derive(Clone, Copy, Debug)]
struct Model {
    issue_output: By,
    x_paid: bool,
    change: Option<bool>, // None: unconsumed; Some(true): paid to Y
    change_reclaimed: bool,
    child: Child,
    paid: u64,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]
    #[test]
    fn no_sequence_pays_an_output_twice_or_more_than_the_backing(
        steps in proptest::collection::vec(step(), 1..14),
        shorter in shorter(),
    ) {
        let mut env = Env::new(TokenKind::Classic);
        let issuer = env.issuer(1, 100_000_000, BACKING, 60);
        // The owner of the issues and the second holder are registered devices of other wallets.
        let holder = env.issuer(2, 1_000_000, 10_000_000, 60);
        let second = env.issuer(3, 1_000_000, 10_000_000, 60);
        let (pa, pb, px, py, pf) = (
            Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(),
        );
        let (ta, tb, tx, ty, tf) = (
            env.token_account_of(&pa, 0), env.token_account_of(&pb, 0), env.token_account_of(&px, 0),
            env.token_account_of(&py, 0), env.token_account_of(&pf, 0),
        );
        let expiry = expiry_of(&env, 10);
        let child_expiry = expiry - shorter;
        let issues: Vec<Chain> = (0..ISSUES)
            .map(|i| Chain::issue(&issuer.key, &env.mint, 0, i as u64 * AMOUNT, AMOUNT, holder.key.owner(), caveats(expiry, 6)))
            .collect();
        let pay_x = |c: Chain, salt: u8| c.spend2(&holder.key, 0, Owner::Account(px.to_bytes()), PART, 0, salt);
        let to_second = |c: Chain| {
            c.spend(&holder.key, 0, |o| Spend {
                input: o.id,
                lock_seq: 0,
                salt: [5; 16],
                outputs: Outputs::One {
                    owner: second.key.owner(),
                    caveats: Caveats { expiry: child_expiry, hops_left: o.caveats.hops_left - 1, ..o.caveats },
                },
            })
        };
        let mut model = [Model { issue_output: By::None, x_paid: false, change: None, change_reclaimed: false, child: Child::Free, paid: 0 }; ISSUES];
        let level_times = [
            i64::from(env.now()),
            i64::from(child_expiry) + i64::from(GRACE) + 1,
            i64::from(expiry) + i64::from(GRACE) + 1,
            i64::from(expiry) + i64::from(GRACE) + i64::from(RECORD_TTL) + 1,
        ];
        let mut level = 0usize;
        let payer = env.payer.pubkey();

        for s in steps {
            let now = i64::from(env.now());
            let g = i64::from(GRACE);
            let ttl = i64::from(RECORD_TTL);
            let (e, e1) = (i64::from(expiry), i64::from(child_expiry));
            let open_issue = now <= e + g;
            let open_child = now <= e1 + g;
            let reclaim_issue = now > e + g && now < e + g + ttl;
            let reclaim_child = now > e1 + g && now < e1 + g + ttl;
            env.svm.expire_blockhash();
            let (ixs, expect_ok): (Vec<_>, bool) = match s {
                Step::Warp(to) => {
                    if usize::from(to) > level {
                        level = usize::from(to);
                        env.warp(level_times[level]);
                    }
                    continue;
                }
                Step::A(i) => {
                    let c = issues[i].clone().spend1_to_account(&holder.key, 0, &pa, NO_LOCK, 1);
                    (settle_ixs(&env, &payer, &issuer, &c, &ta), open_issue && model[i].issue_output == By::None)
                }
                Step::B(i) => {
                    let c = issues[i].clone().spend1_to_account(&holder.key, 0, &pb, NO_LOCK, 2);
                    (settle_ixs(&env, &payer, &issuer, &c, &tb), open_issue && model[i].issue_output == By::None)
                }
                Step::C(i) => {
                    let c = pay_x(issues[i].clone(), 3);
                    let ok = open_issue && matches!(model[i].issue_output, By::None | By::C) && !model[i].x_paid;
                    (settle_ixs(&env, &payer, &issuer, &c, &tx), ok)
                }
                Step::D(i) => {
                    let c = pay_x(issues[i].clone(), 3).spend1_to_account(&holder.key, 1, &py, NO_LOCK, 4);
                    let ok = open_issue && matches!(model[i].issue_output, By::None | By::C) && model[i].change.is_none() && !model[i].change_reclaimed;
                    (settle_ixs(&env, &payer, &issuer, &c, &ty), ok)
                }
                Step::F(i) => {
                    let c = to_second(issues[i].clone()).spend1_to_account(&second.key, 0, &pf, NO_LOCK, 6);
                    let ok = open_child && matches!(model[i].issue_output, By::None | By::F) && model[i].child == Child::Free;
                    // Once the first hop is on record the transaction carries the last signature only.
                    let covered = if model[i].issue_output == By::F { 2 } else { 0 };
                    (settle_ixs_resumed(&env, &payer, &issuer, &c, &tf, covered), ok)
                }
                Step::P(i) => {
                    // Only the issue's output is consumed, so the issue's window governs.
                    let c = to_second(issues[i].clone());
                    let ok = open_issue && matches!(model[i].issue_output, By::None | By::F);
                    (record_prefix_ixs(&payer, &issuer, &c, 0), ok)
                }
                Step::ReclaimIssue(i) => {
                    let ok = reclaim_issue && model[i].issue_output == By::None;
                    (reclaim_ixs(&env, &payer, &issuer, &issues[i], 0, &holder.key, &holder.wallet_token), ok)
                }
                Step::ReclaimChange(i) => {
                    let c = pay_x(issues[i].clone(), 3);
                    let ok = reclaim_issue && matches!(model[i].issue_output, By::None | By::C) && model[i].change.is_none() && !model[i].change_reclaimed;
                    (reclaim_ixs(&env, &payer, &issuer, &c, 1, &holder.key, &holder.wallet_token), ok)
                }
                Step::ReclaimChild(i) => {
                    let c = to_second(issues[i].clone());
                    let ok = reclaim_child && matches!(model[i].issue_output, By::None | By::F) && model[i].child == Child::Free;
                    (reclaim_ixs(&env, &payer, &issuer, &c, 0, &second.key, &second.wallet_token), ok)
                }
            };
            let result = env.submit(&ixs);
            prop_assert_eq!(result.is_ok(), expect_ok, "{:?} at +{}s: {:?}", s, now - T0, result);
            if result.is_err() { continue; }
            match s {
                Step::A(i) => { model[i].issue_output = By::A; model[i].paid += AMOUNT; }
                Step::B(i) => { model[i].issue_output = By::B; model[i].paid += AMOUNT; }
                Step::C(i) => { model[i].issue_output = By::C; model[i].x_paid = true; model[i].paid += PART; }
                Step::D(i) => {
                    model[i].issue_output = By::C; model[i].change = Some(true); model[i].paid += AMOUNT - PART;
                }
                Step::F(i) => { model[i].issue_output = By::F; model[i].child = Child::Paid; model[i].paid += AMOUNT; }
                Step::P(i) => { model[i].issue_output = By::F; }
                Step::ReclaimIssue(i) => { model[i].issue_output = By::ReclaimIssue; model[i].paid += AMOUNT; }
                Step::ReclaimChange(i) => {
                    model[i].issue_output = By::C; model[i].change_reclaimed = true; model[i].paid += AMOUNT - PART;
                }
                Step::ReclaimChild(i) => { model[i].issue_output = By::F; model[i].child = Child::Reclaimed; model[i].paid += AMOUNT; }
                Step::Warp(_) => unreachable!(),
            }

            let total: u64 = model.iter().map(|m| m.paid).sum();
            let received = [ta, tb, tx, ty, tf, holder.wallet_token, second.wallet_token].iter().map(|t| env.balance(t)).sum::<u64>();
            prop_assert_eq!(received, total, "every unit paid out is accounted to exactly one output");
            prop_assert_eq!(env.ledger(&issuer.lock).backing_left, BACKING - total);
            prop_assert_eq!(env.balance(&escrow_address(&issuer.lock)), BACKING + 100_000_000 - total);
            for m in &model {
                prop_assert!(m.paid <= AMOUNT, "an issue never pays more than it issued");
            }
        }
    }
}
