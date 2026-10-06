//! Claims at depth: the gateway names the culprit at the exact hop of a chain of up to sixteen
//! spends, only for a claim the program accepts, and counts the records that vouch for the first
//! messages of an unbacked chain.
mod support;

use axum::http::StatusCode;
use buckspay_client::{accounts::Ledger, types::Link};
use buckspay_gateway::transactions;
use buckspay_protocol::{
    Caveats, Outputs,
    chain::{self, Holding},
    lock::Windows,
    record,
};
use serde_json::Value;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use std::time::Duration;
use support::*;

const BOND: u64 = 20_000_000;
const BACKING: u64 = 20_000_000;
const PAID: u64 = 5_000_000;
const LOSS: u64 = 1_000_000;
const W: Windows = Windows::SHORT;

/// A note from `issuer` that `holders[0..=handovers]` pass on, the last of them to `payee`:
/// `handovers + 1` spends.
fn note_to(
    issuer: &Issuer,
    holders: &[Device],
    handovers: usize,
    payee: &Pubkey,
    start: u64,
    amount: u64,
    expiry: u32,
) -> Note {
    let mut note = issuer.issue_with_hops(&holders[0], start, amount, expiry, 16);
    for i in 0..handovers {
        let caveats = Caveats {
            hops_left: note.last.first.caveats.hops_left - 1,
            ..note.last.first.caveats
        };
        note = note.spend(
            &holders[i],
            0,
            Outputs::One {
                owner: holders[i + 1].owner(),
                caveats,
            },
            0,
        );
    }
    note.settle_to(&holders[handovers], 0, payee)
}

/// Holder `hop` (1-based) of a chain double spends its output: one branch pays the winner's
/// account, the other goes on to the victim.
struct Scene {
    sponsor: Sponsor,
    issuer: Issuer,
    culprit: Issuer,
    holders: Vec<Device>,
    winner: Wallet,
    victim: Wallet,
    expiry: u32,
    hop: usize,
}

async fn scene(hop: usize, length: usize) -> Scene {
    let sponsor = Sponsor::new(caps()).await;
    let issuer = Issuer::new(&sponsor, BOND, BACKING, W.min_lock() + 300).await;
    let culprit = Issuer::new(&sponsor, BOND, BACKING, W.min_lock() + 300).await;
    let holders = (0..length)
        .map(|i| {
            if i == hop - 1 {
                Device(culprit.device.0.clone())
            } else {
                Device::random()
            }
        })
        .collect();
    Scene {
        sponsor,
        issuer,
        culprit,
        holders,
        winner: associated_wallet(0).await,
        victim: associated_wallet(0).await,
        // Each hop expires an hour before the output it spends: the protocol of this build.
        expiry: chain_now().await + 16 * 3_600 + W.min_note_life + 200,
        hop,
    }
}

impl Scene {
    fn note(&self, handovers: usize, payee: &Wallet) -> Note {
        note_to(
            &self.issuer,
            &self.holders,
            handovers,
            &payee.keypair.pubkey(),
            0,
            PAID,
            self.expiry,
        )
    }

    /// The branch the culprit pays the winner with; it settles first.
    fn winning(&self) -> Note {
        self.note(self.hop - 1, &self.winner)
    }

    /// The branch that goes on to the victim and loses.
    fn losing(&self) -> Note {
        self.note(self.holders.len() - 1, &self.victim)
    }

    async fn bond_free(&self) -> u64 {
        let ledger = program().find_ledger_pda(&self.culprit.lock()).0;
        Ledger::from_bytes(&account(&ledger).await.unwrap().data)
            .unwrap()
            .bond_free
    }

    async fn claim(&self, note: &Note) -> (StatusCode, Value) {
        self.sponsor
            .post("/v1/fraud/claim", &note.settlement_request())
            .await
    }
}

#[tokio::test]
async fn the_gateway_files_at_the_exact_hop() {
    for hop in [1, 3, 8, 14] {
        let s = scene(hop, 16).await;
        let winning = s.winning();
        let (status, body) = s
            .sponsor
            .post("/v1/settlements", &winning.settlement_request())
            .await;
        assert_eq!(status, StatusCode::OK, "hop {hop}: {body}");

        let losing = s.losing();
        let (status, body) = s
            .sponsor
            .post("/v1/settlements", &losing.settlement_request())
            .await;
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::CONFLICT, Some("conflict")),
            "hop {hop}"
        );
        let mut tries = 0;
        let answer = loop {
            let (status, body) = s.claim(&losing).await;
            if status == StatusCode::OK {
                break body;
            }
            tries += 1;
            assert!(tries < 60, "hop {hop}: no claim: {body}");
            tokio::time::sleep(Duration::from_millis(500)).await;
        };
        assert_eq!(answer["hop"], hop - 1, "{answer}");
        assert_eq!(answer["culprit"], hex::encode(s.culprit.device.key()));
        assert_eq!(answer["burned"], (2 * PAID).to_string());
        assert_eq!(s.bond_free().await, BOND - 2 * PAID, "hop {hop}");
        assert_eq!(token_balance(&s.victim.token).await, 0, "nobody is paid");
    }
}

#[tokio::test]
async fn a_second_report_of_the_same_loss_is_already_not_an_error() {
    let s = scene(2, 4).await;
    let (status, body) = s
        .sponsor
        .post("/v1/settlements", &s.winning().settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let losing = s.losing();
    let (status, first) = s.claim(&losing).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["state"], "filed");
    assert!(first["signature"].is_string());
    let (status, second) = s.claim(&losing).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["state"], "already");
    assert!(second["signature"].is_null());
    assert_eq!(
        (&second["hop"], &second["culprit"], &second["burned"]),
        (&first["hop"], &first["culprit"], &first["burned"])
    );
    assert_eq!(s.bond_free().await, BOND - 2 * PAID);
}

/// A body nobody signed names nobody, whatever the records say of it.
#[tokio::test]
async fn a_chain_whose_culprit_signature_does_not_verify_names_nobody() {
    let s = scene(3, 6).await;
    let (status, body) = s
        .sponsor
        .post("/v1/settlements", &s.winning().settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut request = s.losing().settlement_request();
    let culprit = request["spends"][2].as_str().unwrap().to_owned();
    let at = culprit.len() - 100;
    let flipped = if &culprit[at..=at] == "0" { "1" } else { "0" };
    request["spends"][2] =
        Value::String(format!("{}{flipped}{}", &culprit[..at], &culprit[at + 1..]));
    let (status, body) = s.sponsor.post("/v1/fraud/claim", &request).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("not_claimable"))
    );
    assert!(body.get("culprit").is_none());
    assert_eq!(s.bond_free().await, BOND);
}

/// Records the first `spends` consumed outputs of `note` without paying anyone, carrying the
/// signatures of the messages from `covered` on.
async fn record_prefix(note: &Note, spends: usize, covered: usize, payer: &Keypair, lock: Pubkey) {
    let domain = note_domain();
    let (envelope, output) = chain::issue_signing(&domain, &note.issue.message).unwrap();
    let mut entries = vec![(note.issue.message.issuer, envelope, note.issue.signature)];
    let mut last = Holding {
        first: output,
        second: None,
    };
    let (mut links, mut consumed) = (Vec::new(), Vec::new());
    for spend in &note.spends[..spends] {
        let input = last.first;
        let (holder, envelope) = chain::spend_signing(&domain, &input, &spend.message).unwrap();
        let (next, _) = chain::spend_outputs(&envelope, &input, &spend.message).unwrap();
        let mut body = [0; 123];
        let len = spend.message.body(&mut body);
        links.push(Link {
            input: 0,
            body: body[..len].to_vec(),
        });
        entries.push((holder, envelope, spend.signature));
        consumed.push(Pubkey::new_from_array(
            record::address(&program().id().to_bytes(), &input.id).unwrap(),
        ));
        last = next;
    }
    let verified: Vec<_> = entries[covered..]
        .iter()
        .map(|entry| (entry.0, entry.1))
        .collect();
    let signatures: Vec<[u8; 64]> = entries[covered..].iter().map(|entry| entry.2).collect();
    send_v1_as(
        payer,
        &[
            transactions::chain_verification(&verified, &signatures).unwrap(),
            transactions::record_prefix(
                &program(),
                payer.pubkey(),
                lock,
                note.issue.message.body(),
                links,
                &consumed,
            ),
        ],
    )
    .await;
}

/// The issuer backs 3 and pays a note of 2; a note of 2 through twelve spends cannot be paid, and
/// its thirteen signatures are too many for one verification unless records vouch for the first
/// of them.
#[tokio::test]
async fn an_unbacked_chain_is_claimed_with_the_records_that_vouch_for_its_first_messages() {
    let sponsor = Sponsor::new(caps()).await;
    let issuer = Issuer::new(&sponsor, 10_000_000, 3 * LOSS, W.min_lock() + 300).await;
    let expiry = chain_now().await + 16 * 3_600 + W.min_note_life + 200;
    let (winner, victim) = (associated_wallet(0).await, associated_wallet(0).await);
    let paid = issuer.issue_to_self(0, 2 * LOSS, expiry).settle_to(
        &issuer.device,
        0,
        &winner.keypair.pubkey(),
    );
    let (status, body) = sponsor
        .post("/v1/settlements", &paid.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let holders: Vec<Device> = (0..12).map(|_| Device::random()).collect();
    let unbacked = note_to(
        &issuer,
        &holders,
        11,
        &victim.keypair.pubkey(),
        LOSS,
        2 * LOSS,
        expiry,
    );

    // Thirteen messages, none vouched for: the claim waits for records.
    let (status, body) = sponsor
        .post("/v1/fraud/claim", &unbacked.settlement_request())
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("not_claimable"))
    );

    // Seven recorded outputs vouch for eight messages: five are left to verify.
    let payer = funded(1_000_000_000).await;
    record_prefix(&unbacked, 7, 0, &payer, issuer.lock()).await;
    let (status, body) = sponsor
        .post("/v1/fraud/claim", &unbacked.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "filed");
    assert_eq!(body["hop"], Value::Null);
    assert_eq!(body["culprit"], hex::encode(issuer.device.key()));
    assert_eq!(body["burned"], (4 * LOSS).to_string());
    let ledger = program().find_ledger_pda(&issuer.lock()).0;
    let ledger = Ledger::from_bytes(&account(&ledger).await.unwrap().data).unwrap();
    assert_eq!(ledger.bond_free, 10_000_000 - 4 * LOSS);
}
