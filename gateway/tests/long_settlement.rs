//! Chains of 8 to 16 spends settle through the gateway in several transactions, planned from the
//! records on chain, and a settlement the gateway started is finished by the janitor.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{
    janitor,
    jobs::{JobState, Jobs, SettlementJob},
    limits::Prefix,
    sponsor::SponsorLimits,
};
use buckspay_protocol::{Caveats, Outputs, lock::Windows};
use serde_json::json;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use support::*;

const BOND: u64 = 20_000_000;
const BACKING: u64 = 20_000_000;
const PAID: u64 = 5_000_000;
const W: Windows = Windows::SHORT;

/// A note from `culprit` through `holders[0..=handovers]` that the last of them pays to `payee`:
/// `handovers + 1` spends.
fn note_to(
    culprit: &Issuer,
    holders: &[Device],
    handovers: usize,
    payee: &Pubkey,
    amount: u64,
    expiry: u32,
) -> Note {
    let mut note = culprit.issue_with_hops(&holders[0], 0, amount, expiry, 16);
    for i in 0..handovers {
        let hops_left = note.last.first.caveats.hops_left;
        let caveats = Caveats {
            hops_left: hops_left - 1,
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

struct Long {
    sponsor: Sponsor,
    culprit: Issuer,
    holders: Vec<Device>,
    payee: Wallet,
    expiry: u32,
}

async fn long() -> Long {
    let sponsor = Sponsor::new(caps()).await;
    long_on(sponsor).await
}

async fn long_on(sponsor: Sponsor) -> Long {
    let culprit = Issuer::new(&sponsor, BOND, BACKING, W.min_lock() + 300).await;
    Long {
        sponsor,
        culprit,
        holders: (0..16).map(|_| Device::random()).collect(),
        payee: associated_wallet(0).await,
        // Each hop expires an hour before the output it spends: the protocol of this build.
        expiry: chain_now().await + 16 * 3_600 + W.min_note_life + 200,
    }
}

impl Long {
    fn note(&self, handovers: usize, amount: u64) -> Note {
        note_to(
            &self.culprit,
            &self.holders,
            handovers,
            &self.payee.keypair.pubkey(),
            amount,
            self.expiry,
        )
    }
}

fn job_of(note: &Note) -> SettlementJob {
    SettlementJob {
        key: "job".into(),
        issue: note.issue_hex(),
        spends: note.spend_hexes(),
        prefix: Prefix::V4([203, 0, 113]),
        created_at: 1,
        deadline: u32::MAX,
        batches_done: 0,
        state: JobState::Pending,
        last_signature: None,
        last_valid_block_height: None,
        not_before: None,
        zk: None,
    }
}

/// The transactions a fresh gateway sent from `address`, which the validator lists after the
/// airdrop that funded it: waits until `expected` are listed and a moment more for any other.
async fn sent_by(address: &Pubkey, expected: usize) -> usize {
    let list = || async {
        solana_rpc_client::nonblocking::rpc_client::RpcClient::new_with_commitment(
            cluster().url.clone(),
            solana_commitment_config::CommitmentConfig::confirmed(),
        )
        .get_signatures_for_address(address)
        .await
        .unwrap()
        .len()
    };
    for _ in 0..240 {
        if list().await > expected {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    list().await - 1
}

fn jobs_in(dir: &tempfile::TempDir) -> Jobs {
    Jobs::open(&dir.path().join("jobs.json")).unwrap()
}

async fn gateway_with(jobs: Jobs, url: &str) -> Sponsor {
    Sponsor::on_jobs(
        rpc(url),
        funded(1_000_000_000).await,
        SponsorLimits::new(caps()),
        buckspay_gateway::float::SettlementLimits::new(float_caps()),
        settings(),
        buckspay_gateway::server::ClientAddress::Peer,
        rents().await,
        1_000,
        jobs,
    )
}

#[tokio::test]
async fn a_sixteen_spend_chain_is_settled_through_the_gateway_in_three_transactions() {
    let t = long().await;
    let note = t.note(15, PAID);
    assert_eq!(note.spends.len(), 16);
    let gateway = gateway_with(Jobs::default(), &cluster().url).await;
    let before = balance(&gateway.fee_payer).await;
    let (status, body) = gateway
        .post("/v1/settlements", &note.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["batches"], json!({ "done": 3, "total": 3 }));
    assert_eq!(sent_by(&gateway.fee_payer, 3).await, 3);
    assert_eq!(token_balance(&t.payee.token).await, PAID);
    let spent = before - balance(&gateway.fee_payer).await;
    let rent = 16 * rents().await.record;
    eprintln!(
        "16 spends: fees {} lamports, record rents {rent}",
        spent - rent
    );
    // Settling it again pays nothing more.
    let (status, body) = gateway
        .post("/v1/settlements", &note.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "settled");
    assert_eq!(token_balance(&t.payee.token).await, PAID);
}

#[tokio::test]
async fn a_gateway_killed_between_batches_finishes_on_restart() {
    let dir = tempfile::tempdir().unwrap();
    let t = long().await;
    let note = t.note(15, PAID);
    // The first gateway's sends land and it is told nothing: as if it died after the first one.
    let cut = faulty_relay(&cluster().url, Fault::CutAfterSend).await;
    let first = gateway_with(jobs_in(&dir), &cut).await;
    let (status, _) = first
        .post("/v1/settlements", &note.settlement_request())
        .await;
    assert_ne!(status, StatusCode::OK);
    assert_eq!(sent_by(&first.fee_payer, 1).await, 1);
    assert_eq!(token_balance(&t.payee.token).await, 0);

    // A new gateway on the same jobs: one pass of the janitor settles the chain.
    let second = gateway_with(jobs_in(&dir), &cluster().url).await;
    let report = janitor::run_once(&second.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(report.jobs_resumed, 1);
    assert_eq!(token_balance(&t.payee.token).await, PAID);
    assert_eq!(
        sent_by(&second.fee_payer, 2).await,
        2,
        "the batch that landed is not sent again"
    );
    assert!(second.gateway.jobs.pending().is_empty());
}

#[tokio::test]
async fn a_job_whose_chain_turns_out_to_conflict_ends_and_sends_nothing_more() {
    let dir = tempfile::tempdir().unwrap();
    let t = long().await;
    let note = t.note(15, PAID);
    let cut = faulty_relay(&cluster().url, Fault::CutAfterSend).await;
    let first = gateway_with(jobs_in(&dir), &cut).await;
    first
        .post("/v1/settlements", &note.settlement_request())
        .await;

    // The holder of the ninth message spent the same output to somebody else and that settles.
    let thief = associated_wallet(0).await;
    let rival = note_to(
        &t.culprit,
        &t.holders,
        8,
        &thief.keypair.pubkey(),
        PAID,
        t.expiry,
    );
    let (status, body) = t
        .sponsor
        .post("/v1/settlements", &rival.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(token_balance(&thief.token).await, PAID);

    let second = gateway_with(jobs_in(&dir), &cluster().url).await;
    janitor::run_once(&second.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert!(second.gateway.jobs.pending().is_empty());
    assert_eq!(sent_by(&second.fee_payer, 0).await, 0);
    assert_eq!(token_balance(&t.payee.token).await, 0);
}

#[tokio::test]
async fn a_job_past_its_deadline_is_marked_expired_and_sends_nothing() {
    let t = long().await;
    let note = t.note(15, PAID);
    let jobs = Jobs::default();
    jobs.begin(SettlementJob {
        deadline: 1,
        ..job_of(&note)
    })
    .unwrap();
    let sponsor = gateway_with(jobs, &cluster().url).await;
    janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(
        sponsor.gateway.jobs.get("job").unwrap().state,
        JobState::Expired
    );
    assert_eq!(sent_by(&sponsor.fee_payer, 0).await, 0);
    assert_eq!(token_balance(&t.payee.token).await, 0);
}

#[tokio::test]
async fn a_job_the_program_refuses_for_good_stops_as_refused() {
    let t = long().await;
    // A chain that does not end at an account: no transaction can ever settle it.
    let handed = t
        .culprit
        .issue_with_hops(&t.holders[0], 0, PAID, t.expiry, 16)
        .spend(
            &t.holders[0],
            0,
            Outputs::One {
                owner: t.holders[1].owner(),
                caveats: caveats(t.expiry, 15),
            },
            0,
        );
    let jobs = Jobs::default();
    jobs.begin(job_of(&handed)).unwrap();
    let sponsor = gateway_with(jobs, &cluster().url).await;
    janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(
        sponsor.gateway.jobs.get("job").unwrap().state,
        JobState::Refused
    );
    assert_eq!(sent_by(&sponsor.fee_payer, 0).await, 0);
}

#[tokio::test]
async fn a_job_does_not_resend_while_its_last_signature_is_unresolved() {
    let t = long().await;
    let note = t.note(15, PAID);
    let jobs = Jobs::default();
    jobs.begin(job_of(&note)).unwrap();
    // A transaction nobody has seen, that can still land for a very long time.
    jobs.sent(
        "job",
        &solana_signature::Signature::from([7; 64]).to_string(),
        u64::MAX,
    )
    .unwrap();
    let sponsor = gateway_with(jobs, &cluster().url).await;
    janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(
        sponsor.gateway.jobs.get("job").unwrap().state,
        JobState::Pending
    );
    assert_eq!(sent_by(&sponsor.fee_payer, 0).await, 0);
}

#[tokio::test]
async fn the_plan_is_rederived_from_chain_records_not_from_the_job_counter() {
    let t = long().await;
    let note = t.note(15, PAID);
    // A first gateway lands the first batch, which it is not told about.
    let cut = faulty_relay(&cluster().url, Fault::CutAfterSend).await;
    let first = gateway_with(Jobs::default(), &cut).await;
    first
        .post("/v1/settlements", &note.settlement_request())
        .await;
    assert_eq!(sent_by(&first.fee_payer, 1).await, 1);

    // A gateway that knows nothing of it sends the other two.
    let (status, body) = t
        .sponsor
        .post("/v1/settlements", &note.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["batches"], json!({ "done": 2, "total": 2 }));
    assert_eq!(token_balance(&t.payee.token).await, PAID);
}

#[tokio::test]
async fn a_sixteen_spend_request_below_the_whole_chains_minimum_is_refused() {
    let t = long().await;
    // The first batch alone creates 7 records, the chain 16: the minimum is for all of them.
    let note = t.note(15, 400_000);
    let gateway = gateway_with(Jobs::default(), &cluster().url).await;
    let (status, body) = gateway
        .post("/v1/settlements", &note.settlement_request())
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], "below_minimum");
    assert_eq!(sent_by(&gateway.fee_payer, 0).await, 0);
}

#[tokio::test]
async fn a_sixteen_spend_request_is_read_by_the_claim_path_too() {
    let t = long().await;
    let note = t.note(15, PAID);
    let (status, body) = t
        .sponsor
        .post("/v1/fraud/claim", &note.settlement_request())
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "not_claimable");
}
