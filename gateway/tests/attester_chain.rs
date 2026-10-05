//! The attester against a validator that runs the short-windows program and the cluster's token
//! programs: it registers, reads a real lock from two providers, signs a ticket a receiver accepts
//! with the registry entry read from the chain, and a ticket the chain contradicts burns its stake.
mod support;

use axum::{
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Request, StatusCode, header},
};
use buckspay_client::{
    Program,
    accounts::{Attester as AttesterAccount, Ledger},
    instructions::{RegisterAttesterBuilder, ReportFalseTicketBuilder},
};
use buckspay_gateway::{
    attester::{
        limits::{Limits, Settings},
        plan::{Issuer, Policy},
        reader::Providers,
        server::{Service, router},
    },
    chain,
    server::ClientAddress,
};
use buckspay_protocol::{
    BondTicket, Owner,
    cluster::DEVNET_GENESIS_HASH,
    hash::{domain, purpose},
    ticket::{Attester, Need, accept},
};
use ed25519_dalek::{Signer as _, SigningKey};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{net::SocketAddr, sync::Arc};
use support::*;
use tower::ServiceExt;

const BOND: u64 = 2_000_000;
const BACKING: u64 = 3_000_000;
const STAKE: u64 = 100_000_000;
const DAY: u32 = 86_400;

/// Sends `instructions` paid and signed by `payer`; returns the compute units and the wire size.
async fn land(payer: &Keypair, instructions: &[Instruction]) -> (u64, usize) {
    let rpc = rpc(&cluster().url);
    let transaction = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &[payer],
        rpc.get_latest_blockhash().await.unwrap(),
    );
    let size = bincode_len(&transaction);
    let signature = rpc
        .send_and_confirm_transaction(&transaction)
        .await
        .unwrap();
    (units_of(&signature.to_string()).await, size)
}

fn bincode_len(transaction: &Transaction) -> usize {
    transaction.message.serialize().len() + 1 + 64 * transaction.signatures.len()
}

/// The Ed25519 verification instruction `new_ed25519_instruction_with_signature` builds.
fn ed25519_ix(key: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> Instruction {
    let mut data = vec![1u8, 0];
    for field in [
        48u16,
        u16::MAX,
        16,
        u16::MAX,
        112,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&field.to_le_bytes());
    }
    data.extend_from_slice(key);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    Instruction {
        program_id: Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

fn supply(mint: &Pubkey) -> impl std::future::Future<Output = u64> {
    let mint = *mint;
    async move {
        let account = account(&mint).await.unwrap();
        u64::from_le_bytes(account.data[36..44].try_into().unwrap())
    }
}

#[tokio::test]
async fn a_ticket_from_a_real_lock_verifies_and_a_false_one_burns_the_stake() {
    let program: Program = program();
    let mint = cluster().mint;
    let key = SigningKey::from_bytes(&[0x42; 32]);
    let authority = funded(10_000_000_000).await;
    let funder = token_account(&authority.pubkey(), 2 * STAKE).await;
    let attester =
        Pubkey::find_program_address(&[b"attester", &1u16.to_le_bytes()], &program.id()).0;
    let ledger = Pubkey::find_program_address(&[b"ledger", attester.as_ref()], &program.id()).0;
    let escrow = Pubkey::find_program_address(&[b"escrow", attester.as_ref()], &program.id()).0;

    let register = program.target(
        RegisterAttesterBuilder::new()
            .authority(authority.pubkey())
            .payer(authority.pubkey())
            .attester(attester)
            .ledger(ledger)
            .escrow(escrow)
            .mint(mint)
            .funder(funder)
            .token_program(chain::TOKEN_PROGRAM)
            .system_program(Pubkey::default())
            .id(1)
            .key(key.verifying_key().to_bytes())
            .stake(STAKE)
            .instruction(),
    );
    let (units, size) = land(&authority, &[register]).await;
    within("register_attester", units, 60_000, size, 700);

    // A user with a real lock, sponsored through the gateway as in production.
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(2 * (BOND + BACKING)).await;
    let device = Device::random();
    let until = chain_now().await + 30 * DAY;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    let (status, body) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The attester reads at finalized: wait for the lock to get there.
    let lock = program.find_lock_pda(&device.key(), 0).0;
    let finalized = rpc(&cluster().url);
    let mut waited = 0;
    while finalized
        .get_account_with_commitment(
            &lock,
            solana_commitment_config::CommitmentConfig::finalized(),
        )
        .await
        .unwrap()
        .value
        .is_none()
    {
        waited += 1;
        assert!(waited < 120, "the lock did not finalize");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // The service reads it from two providers, as it would behind its own socket.
    let second = cluster().url.replace("127.0.0.1", "localhost");
    let providers = Providers::new(program, [&cluster().url, &second]).unwrap();
    let ticket_domain = domain(
        purpose::TICKET,
        &DEVNET_GENESIS_HASH,
        &program.id().to_bytes(),
    );
    let policy = Policy {
        attester: 1,
        mint: mint.to_bytes(),
        lifetimes: [DAY, 255_600],
        quantum: 3_600,
    };
    let service = Arc::new(Service::new(
        providers,
        Issuer::new([0x42; 32], ticket_domain),
        policy,
        authority.pubkey().to_bytes(),
        Limits::in_memory(Settings::pilot()),
        None,
    ));
    let app = router(service, ClientAddress::Peer).layer(MockConnectInfo(
        "203.0.113.7:4000".parse::<SocketAddr>().unwrap(),
    ));
    let request = |lock_seq: u32| {
        let body = json!({
            "locks": [{ "key": hex::encode(device.key()), "lockSeq": lock_seq }],
            "lifetime": DAY,
        });
        Request::post("/v1/tickets")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let answer = |response: axum::response::Response| async move {
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice::<Value>(&bytes).unwrap())
    };
    let (status, body) = answer(app.clone().oneshot(request(0)).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["status"], "ok", "{body}");
    let ticket =
        BondTicket::decode(&hex::decode(body["results"][0]["ticket"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!((ticket.bond, ticket.backing), (BOND, BACKING));

    // A lock that does not exist gets no ticket.
    let (_, body) = answer(app.clone().oneshot(request(5)).await.unwrap()).await;
    assert_eq!(body["results"][0]["reason"], "lock_absent");

    // A receiver reads the registry entry from the chain and accepts the ticket.
    let record = AttesterAccount::from_bytes(&account(&attester).await.unwrap().data).unwrap();
    let free = Ledger::from_bytes(&account(&ledger).await.unwrap().data)
        .unwrap()
        .bond_free;
    let now = chain_now().await;
    let entry = Attester::new(
        1,
        record.authority.to_bytes(),
        record.mint.to_bytes(),
        free,
        record.key,
        now,
    );
    let need = Need {
        mint: &mint.to_bytes(),
        amount: BOND / 4,
        backing: Some(BACKING),
        expiry: now + 3_600,
    };
    let liability = accept(
        now,
        &ticket_domain,
        &[entry],
        &[ticket],
        &Owner::Device(device.key()),
        0,
        &need,
    )
    .unwrap();
    assert_eq!((liability.bond, liability.attester), (BOND, 1));

    // A ticket the chain contradicts, signed by the same key, destroys the whole stake.
    let phantom = Device::random();
    let mut false_ticket = BondTicket {
        device: phantom.key(),
        mint: mint.to_bytes(),
        lock_seq: 0,
        bond: BOND,
        backing: BACKING,
        lock_until: until,
        valid_until: now + DAY,
        attester: 1,
        signature: [0; 64],
    };
    let message = false_ticket.signed_message(&ticket_domain);
    false_ticket.signature = key.sign(&message).to_bytes();
    let reporter = funded(1_000_000_000).await;
    let report = program.target(
        ReportFalseTicketBuilder::new()
            .reporter(reporter.pubkey())
            .attester(attester)
            .ledger(ledger)
            .escrow(escrow)
            .mint(mint)
            .device(program.find_device_pda(&phantom.key()).0)
            .lock(program.find_lock_pda(&phantom.key(), 0).0)
            .instructions(Pubkey::from_str_const(
                "Sysvar1nstructions1111111111111111111111111",
            ))
            .token_program(chain::TOKEN_PROGRAM)
            .ticket(false_ticket.encode())
            .instruction(),
    );
    let before = supply(&mint).await;
    let (units, size) = land(
        &reporter,
        &[
            ed25519_ix(
                &key.verifying_key().to_bytes(),
                &false_ticket.signature,
                &message,
            ),
            report,
        ],
    )
    .await;
    within("report_false_ticket", units, 50_000, size, 900);
    assert_eq!(before - supply(&mint).await, STAKE);
    assert_eq!(token_balance(&escrow).await, 0);
    let record = AttesterAccount::from_bytes(&account(&attester).await.unwrap().data).unwrap();
    assert_eq!(record.status, 3);
}
