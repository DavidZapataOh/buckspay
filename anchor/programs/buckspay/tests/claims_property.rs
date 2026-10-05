//! The program against the model of `slash_model.rs`: for any run of double spends, whoever files
//! the claims, the free bond falls by what `slash::penalty` says claim after claim, the supply
//! falls by exactly that, and not one other token account moves.
mod common;
use buckspay::BuckspayError as E;
use buckspay_protocol::slash;
use common::claims::*;
use common::*;
use proptest::prelude::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn a_run_of_claims_burns_what_the_model_says_and_pays_nobody(
        losses in proptest::collection::vec(1u64..=LIMIT, 1..6),
        strangers in proptest::collection::vec(any::<bool>(), 6),
    ) {
        let mut w = world();
        let mut free = BOND;
        let mut outputs = vec![];
        for (i, loss) in losses.iter().enumerate() {
            let start = i as u64 * LIMIT;
            let (winning, losing) = (w.winning_of(start, *loss), w.losing_of(start, 2 + i as u8, *loss));
            w.settle(&winning).unwrap();
            let (before, supply) = (w.balances(), w.env.supply());
            let burn = slash::penalty(*loss, free);
            let stranger = Keypair::new();
            w.env.svm.airdrop(&stranger.pubkey(), 2_000_000_000).unwrap();
            let filer = if strangers[i] { stranger.pubkey() } else { w.payer() };
            let ixs = claim_lost_ixs(
                &filer, &w.culprit.lock, w.culprit.key.sec1(), 0, &w.env.mint, &losing,
            );
            let sent = if strangers[i] {
                w.env.send(&stranger, &ixs)
            } else {
                w.env.submit(&ixs)
            };
            if burn == 0 {
                prop_assert_eq!(sent.unwrap_err(), code(1, E::NoBond));
                w.assert_only_a_burn(&before, supply, &w.culprit.lock, 0);
                continue;
            }
            sent.unwrap();
            free -= burn;
            outputs.push(losing.last.first.id);
            prop_assert_eq!(w.env.ledger(&w.culprit.lock).bond_free, free);
            prop_assert_eq!(w.env.ledger(&w.culprit.lock).bond_slashed, 0);
            w.assert_only_a_burn(&before, supply, &w.culprit.lock, burn);
        }
        // Each claim exists once and says what it burned.
        let burned: u64 = outputs.iter().map(|o| w.env.claim(o).unwrap().burned).sum();
        prop_assert_eq!(burned, BOND - free);
    }
}
