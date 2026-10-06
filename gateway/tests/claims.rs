//! Claims against the validator that runs the short-windows build: the loser of a double spend is
//! claimed by the gateway, the lock burns twice the loss and nobody is paid, and the janitor takes
//! the rent of the claim back when it can be closed.
mod support;

use axum::http::StatusCode;
use buckspay_client::accounts::Ledger;
use buckspay_gateway::{janitor, server::Settings, sponsor::SponsorLimits};
use buckspay_protocol::{Caveats, Outputs, lock::Windows, record};
use serde_json::Value;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use std::time::Duration;
use support::*;

const BOND: u64 = 10_000_000;
const BACKING: u64 = 10_000_000;
const LOSS: u64 = 1_000_000;
const W: Windows = Windows::SHORT;

struct DoubleSpend {
    culprit: Issuer,
    winner: Note,
    loser: Note,
    /// The output the culprit paid the victim with: the loss that is claimed.
    payment: [u8; 32],
    /// The token accounts the two chains pay.
    winner_token: Pubkey,
    victim_token: Pubkey,
}

impl DoubleSpend {
    /// The culprit spends one note to an account, and the same note to a device that settles it.
    async fn new(sponsor: &Sponsor) -> Self {
        let culprit = Issuer::new(sponsor, BOND, BACKING, W.min_lock() + 120).await;
        Self::of(culprit, 0, LOSS).await
    }

    /// The same, of a note of `loss` that starts at `start` of the culprit's backing.
    async fn of(culprit: Issuer, start: u64, loss: u64) -> Self {
        let expiry = chain_now().await + W.min_note_life + 60;
        let victim = Device::random();
        let (winner_wallet, victim_wallet) =
            (associated_wallet(0).await, associated_wallet(0).await);
        let winner = culprit.issue_to_self(start, loss, expiry).settle_to(
            &culprit.device,
            0,
            &winner_wallet.keypair.pubkey(),
        );
        let paid = culprit.issue_to_self(start, loss, expiry).spend(
            &culprit.device,
            0,
            Outputs::One {
                owner: victim.owner(),
                caveats: Caveats {
                    hops_left: 5,
                    ..winner.issue.message.caveats
                },
            },
            0,
        );
        let payment = paid.last.first.id;
        let loser = paid.settle_to(&victim, 0, &victim_wallet.keypair.pubkey());
        Self {
            culprit,
            winner,
            loser,
            payment,
            winner_token: winner_wallet.token,
            victim_token: victim_wallet.token,
        }
    }

    fn escrow(&self) -> Pubkey {
        program().find_escrow_pda(&self.culprit.lock()).0
    }

    fn ledger_address(&self) -> Pubkey {
        program().find_ledger_pda(&self.culprit.lock()).0
    }

    async fn ledger(&self) -> Ledger {
        Ledger::from_bytes(&account(&self.ledger_address()).await.unwrap().data).unwrap()
    }

    /// The claim of the culprit's payment to the victim.
    fn claim_address(&self) -> Pubkey {
        Pubkey::new_from_array(
            record::claim_address(&program().id().to_bytes(), &self.payment).unwrap(),
        )
    }
}

async fn post(sponsor: &Sponsor, path: &str, note: &Note) -> (StatusCode, Value) {
    sponsor.post(path, &note.settlement_request()).await
}

#[tokio::test]
async fn the_loser_of_a_double_spend_is_claimed_and_the_lock_burns_twice_the_loss() {
    let sponsor = Sponsor::new(caps()).await;
    let fraud = DoubleSpend::new(&sponsor).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &fraud.winner).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (escrow_before, ledger_before) =
        (token_balance(&fraud.escrow()).await, fraud.ledger().await);
    assert_eq!(ledger_before.bond_free, BOND);
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &fraud.loser).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let signature = body["signature"].as_str().expect("the claim was sent");
    let units = units_of(signature).await;
    eprintln!("claim_lost_spend on the validator: {units} CU");
    assert!(units <= 60_000, "{units} CU");

    let ledger = fraud.ledger().await;
    assert_eq!(ledger.bond_free, BOND - 2 * LOSS);
    assert_eq!(ledger.backing_left, ledger_before.backing_left);
    assert_eq!(
        token_balance(&fraud.escrow()).await,
        escrow_before - 2 * LOSS
    );
    assert_eq!(token_balance(&fraud.winner_token).await, LOSS);
    assert_eq!(
        token_balance(&fraud.victim_token).await,
        0,
        "nobody is paid"
    );
    assert_eq!(
        account(&fraud.claim_address()).await.unwrap().data.len(),
        92
    );

    // The same loss is claimed once: the second answer is the first result.
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &fraud.loser).await;
    assert_eq!(
        (status, body["state"].as_str()),
        (StatusCode::OK, Some("already"))
    );
    assert_eq!(fraud.ledger().await.bond_free, BOND - 2 * LOSS);

    // The winning chain is no loss: the record holds it and the backing can pay it.
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &fraud.winner).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("not_claimable"))
    );
    assert_eq!(body.get("selfPay"), None);
}

#[tokio::test]
async fn a_settlement_that_fails_on_a_conflict_files_the_claim_by_itself() {
    let sponsor = Sponsor::new(caps()).await;
    let fraud = DoubleSpend::new(&sponsor).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &fraud.winner).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = post(&sponsor, "/v1/settlements", &fraud.loser).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );
    let mut tries = 0;
    while account(&fraud.claim_address()).await.is_none() {
        tries += 1;
        assert!(tries < 60, "the claim was not filed");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(fraud.ledger().await.bond_free, BOND - 2 * LOSS);
}

#[tokio::test]
async fn the_janitor_takes_the_rent_of_a_claim_back_when_it_can_be_closed() {
    let sponsor = Sponsor::new(caps()).await;
    let fraud = DoubleSpend::new(&sponsor).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &fraud.winner).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &fraud.loser).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let claim = account(&fraud.claim_address()).await.unwrap();
    let closable = u32::from_le_bytes(claim.data[88..92].try_into().unwrap());
    let report = janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(
        report.claims_closed, 0,
        "a claim stays until it can be closed"
    );
    assert!(account(&fraud.claim_address()).await.is_some());

    wait_for_chain(closable).await;
    let before = balance(&sponsor.fee_payer).await;
    let report = janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(report.claims_closed, 1);
    assert!(account(&fraud.claim_address()).await.is_none());
    assert!(balance(&sponsor.fee_payer).await + 10_000 > before + claim.lamports);
}

#[tokio::test]
async fn a_drained_lock_has_nothing_left_to_burn_and_the_answer_says_so() {
    // A payment of the most the bond backs burns half of it: the third finds nothing.
    let sponsor = Sponsor::new(caps()).await;
    let culprit = Issuer::new(&sponsor, BOND, BACKING, W.min_lock() + 120).await;
    let limit = BOND / 4;
    let first = DoubleSpend::of(culprit, 0, limit).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &first.winner).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        post(&sponsor, "/v1/fraud/claim", &first.loser).await.0,
        StatusCode::OK
    );
    assert_eq!(first.ledger().await.bond_free, BOND - 2 * limit);

    let second = DoubleSpend::of(first.culprit, limit, limit).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &second.winner).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        post(&sponsor, "/v1/fraud/claim", &second.loser).await.0,
        StatusCode::OK
    );
    assert_eq!(second.ledger().await.bond_free, 0);

    let third = DoubleSpend::of(second.culprit, 2 * limit, limit).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &third.winner).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &third.loser).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("no_bond"))
    );
    assert!(account(&third.claim_address()).await.is_none());
}

#[tokio::test]
async fn the_cap_on_the_rent_it_fronts_refuses_the_next_claim_and_tells_the_app_to_wait() {
    let one_claim = rents().await.claim;
    let sponsor = Sponsor::with_limits(
        SponsorLimits::new(caps()),
        Settings {
            claim_float_cap: one_claim,
            ..settings()
        },
    )
    .await;
    let first = DoubleSpend::new(&sponsor).await;
    let second = DoubleSpend::new(&sponsor).await;
    for fraud in [&first, &second] {
        let (status, body) = post(&sponsor, "/v1/settlements", &fraud.winner).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    assert_eq!(
        post(&sponsor, "/v1/fraud/claim", &first.loser).await.0,
        StatusCode::OK
    );
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &second.loser).await;
    assert_eq!(
        (status, body["error"].as_str(), body["selfPay"].as_bool()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Some("float_cap"),
            Some(true)
        )
    );
    assert!(account(&second.claim_address()).await.is_none());
}

/// The culprit's issuer backs 3 and signs two notes of 2 that overlap: the second cannot be paid.
async fn unbacked_notes(culprit: &Issuer) -> (Note, Note, Pubkey) {
    let expiry = chain_now().await + W.min_note_life + 60;
    let (winner_wallet, victim_wallet) = (associated_wallet(0).await, associated_wallet(0).await);
    let victim = Device::random();
    let paid = culprit.issue_to_self(0, 2 * LOSS, expiry).settle_to(
        &culprit.device,
        0,
        &winner_wallet.keypair.pubkey(),
    );
    let unbacked = culprit.issue_to(&victim, LOSS, 2 * LOSS, expiry).settle_to(
        &victim,
        0,
        &victim_wallet.keypair.pubkey(),
    );
    (paid, unbacked, victim_wallet.token)
}

#[tokio::test]
async fn a_chain_the_backing_cannot_pay_is_claimed_and_burns_twice_its_amount() {
    let sponsor = Sponsor::new(caps()).await;
    let culprit = Issuer::new(&sponsor, BOND, 3 * LOSS, W.min_lock() + 120).await;
    let (paid, unbacked, victim_token) = unbacked_notes(&culprit).await;
    let ledger = |culprit: &Issuer| {
        let address = program().find_ledger_pda(&culprit.lock()).0;
        async move { Ledger::from_bytes(&account(&address).await.unwrap().data).unwrap() }
    };
    let (status, body) = post(&sponsor, "/v1/settlements", &paid).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(ledger(&culprit).await.backing_left, LOSS);

    // The settlement of the second note fails for lack of backing, and the claim is filed.
    let (status, body) = post(&sponsor, "/v1/settlements", &unbacked).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("insufficient_backing"))
    );
    let mut tries = 0;
    while ledger(&culprit).await.bond_free == BOND {
        tries += 1;
        assert!(tries < 60, "the claim was not filed");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(ledger(&culprit).await.bond_free, BOND - 4 * LOSS);
    assert_eq!(token_balance(&victim_token).await, 0, "nobody is paid");

    // The same loss answers `claimed`, and a chain the backing could pay is no loss.
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &unbacked).await;
    assert_eq!(
        (status, body["state"].as_str()),
        (StatusCode::OK, Some("already"))
    );
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &paid).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("not_claimable"))
    );
}

#[tokio::test]
async fn claim_unbacked_fits_its_budget_on_the_validator() {
    let sponsor = Sponsor::new(caps()).await;
    let culprit = Issuer::new(&sponsor, BOND, 3 * LOSS, W.min_lock() + 120).await;
    let (paid, unbacked, _) = unbacked_notes(&culprit).await;
    let (status, body) = post(&sponsor, "/v1/settlements", &paid).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post(&sponsor, "/v1/fraud/claim", &unbacked).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let units = units_of(body["signature"].as_str().unwrap()).await;
    eprintln!("claim_unbacked on the validator: {units} CU");
    assert!(units <= 60_000, "{units} CU");
}
