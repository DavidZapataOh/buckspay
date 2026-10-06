//! Private settlement in the gateway harness: notes with fixed keys, their scenarios for the
//! prover, the requests built from the recorded proofs and the program's configuration.
//!
//! A note whose proofs are missing is written to the directory named by `ZK_RECORD` and the test
//! stops: `scripts/prove-zk-requests.sh` proves it and writes `tests/fixtures/zk_requests.json`.
#![allow(dead_code)]
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use buckspay_client::{
    instructions::{InitZkConfigBuilder, SetZkMintBuilder, SetZkPausedBuilder},
    types::KeyHashes,
};
use buckspay_protocol::{Caveats, Outputs, Owner, chain, hash::content};
use buckspay_zk_verify::vk;
use serde_json::json;

pub const EXPIRY: u32 = 4_000_000_000;
pub const RECORD_FEE: u64 = 1_000;
pub const PAID: u64 = 5_000_000;

/// The upgrade authority of the test program, the admin and the pauser of its private settlement.
pub fn admin() -> Keypair {
    Keypair::new_from_array([0x55; 32])
}

pub fn payee() -> Keypair {
    Keypair::new_from_array([0x66; 32])
}

pub struct ZkNote {
    pub name: &'static str,
    pub issuer: Device,
    pub note: Note,
}

/// A note of `spends` spends from the device `seed` to the payee, paying `PAID`.
pub fn zk_note(name: &'static str, seed: u8, spends: usize) -> ZkNote {
    let issuer = Device::new(seed);
    let holders: Vec<Device> = (0..spends).map(|i| Device::new(100 + i as u8)).collect();
    let mut note = issue(
        &issuer,
        &cluster().mint,
        0,
        0,
        PAID,
        holders[0].owner(),
        caveats(EXPIRY, 16),
    );
    for i in 0..spends - 1 {
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
    let note = note.settle_to(&holders[spends - 1], 0, &payee().pubkey());
    ZkNote { name, issuer, note }
}

impl ZkNote {
    pub fn lock(&self) -> Pubkey {
        program().find_lock_pda(&self.issuer.key(), 0).0
    }

    /// The scenario the prover reads, and the request without its proofs.
    fn record(&self) -> (String, Value) {
        let domain = note_domain();
        let issue = &self.note.issue;
        let (_, output) = chain::issue_signing(&domain, &issue.message).unwrap();
        let mut last = chain::Holding {
            first: output,
            second: None,
        };
        let issue_body = issue.message.body();
        let mut messages = vec![message_json(
            &issue_body,
            &issue.signature,
            &issue.message.issuer,
        )];
        let mut openings = vec![opening_json(&[0; 33], 0, &[0; 27], &[0; 16], 0)];
        let mut salt = issue.message.salt;
        let mut inputs = Vec::new();
        let mut bodies = vec![issue_body.to_vec()];
        for spend in &self.note.spends {
            let input = [Some(last.first), last.second]
                .into_iter()
                .flatten()
                .find(|o| o.id == spend.message.input)
                .unwrap();
            let index = u8::from(input.id != last.first.id);
            let Owner::Device(key) = input.owner else {
                panic!("a spend of an account")
            };
            let (_, envelope) = chain::spend_signing(&domain, &input, &spend.message).unwrap();
            let (next, _) = chain::spend_outputs(&envelope, &input, &spend.message).unwrap();
            let mut body = [0u8; 123];
            let len = spend.message.body(&mut body);
            messages.push(message_json(&body[..len], &spend.signature, &key));
            openings.push(opening_json(
                &input.owner.encode(),
                input.amount,
                &input.caveats.encode(),
                &salt,
                index,
            ));
            bodies.push(body[..len].to_vec());
            inputs.push(index);
            salt = spend.message.salt;
            last = next;
        }
        let scenario = format!(
            r#"{{"domain":"{}","valid":[{{"name":"gateway-note-{}","messages":[{}],"openings":[{}],"message_ids":[],"output_ids":[],"public":[]}}],"invalid":[]}}"#,
            hex::encode(domain),
            self.name,
            messages.join(","),
            openings.join(",")
        );
        let wire: Vec<Value> = bodies
            .iter()
            .enumerate()
            .map(|(i, body)| {
                json!({
                    "content": B64.encode(content(body)),
                    "nextBit": inputs.get(i).copied().unwrap_or(0),
                    "sOut": "",
                    "proof": "",
                })
            })
            .collect();
        let request = json!({
            "kind": "zk",
            "vkSha256": B64.encode(vk::VK.sha256),
            "lockKey": B64.encode(self.issuer.key()),
            "lockSeq": 0,
            "amount": PAID.to_string(),
            "cumEnd": PAID.to_string(),
            "payAmount": PAID.to_string(),
            "expiry": self.note.last.first.caveats.expiry,
            "payee": B64.encode(payee().pubkey().to_bytes()),
            "messages": wire,
        });
        (scenario, request)
    }

    /// The request of this note with the proofs recorded for it. Without them the note is
    /// written to `ZK_RECORD` for the prover and the test stops.
    pub fn request(&self) -> Value {
        let (scenario, mut request) = self.record();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/zk_requests.json"
        );
        let recorded: Option<Value> = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        if let Some(found) = recorded.map(|file| file["requests"][self.name].clone())
            && found["messages"][0]["proof"]
                .as_str()
                .is_some_and(|proof| !proof.is_empty())
        {
            return found;
        }
        let dir = std::env::var("ZK_RECORD").unwrap_or_else(|_| {
            panic!(
                "no proofs for {}: run scripts/prove-zk-requests.sh",
                self.name
            )
        });
        std::fs::create_dir_all(format!("{dir}/main")).unwrap();
        std::fs::write(format!("{dir}/main/{}.json", self.name), scenario).unwrap();
        request["name"] = json!(self.name);
        std::fs::write(
            format!("{dir}/{}.request.json", self.name),
            serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        panic!(
            "recorded {} in {dir}: prove it and run the tests again",
            self.name
        );
    }
}

fn message_json(body: &[u8], signature: &[u8; 64], key: &[u8; 33]) -> String {
    format!(
        r#"{{"kind":{},"body":"{}","sig_r":"{}","sig_s":"{}","key":"{}"}}"#,
        body[1],
        hex::encode(body),
        hex::encode(&signature[..32]),
        hex::encode(&signature[32..]),
        hex::encode(key)
    )
}

fn opening_json(owner: &[u8], amount: u64, caveats: &[u8], salt: &[u8], index: u8) -> String {
    format!(
        r#"{{"owner":"{}","amount":{amount},"caveats":"{}","salt":"{}","index":{index}}}"#,
        hex::encode(owner),
        hex::encode(caveats),
        hex::encode(salt)
    )
}

pub fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"zk-config"], &program().id()).0
}

pub fn mint_address() -> Pubkey {
    Pubkey::find_program_address(&[b"zk-mint", cluster().mint.as_ref()], &program().id()).0
}

fn program_data() -> Pubkey {
    Pubkey::find_program_address(
        &[program().id().as_ref()],
        &Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111"),
    )
    .0
}

/// The token account that receives the record fees.
pub async fn fee_account() -> Pubkey {
    associated_wallet_of(&Keypair::new_from_array([0x77; 32]), 0)
        .await
        .token
}

async fn airdrop(to: &Pubkey, lamports: u64) {
    let rpc = rpc(&cluster().url);
    let signature = rpc.request_airdrop(to, lamports).await.unwrap();
    while !rpc.confirm_transaction(&signature).await.unwrap() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Configures private settlement on the test validator once: the keys the program is built with
/// and the mint with the harness caps and the record fee.
pub async fn configure() {
    static DONE: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    DONE.get_or_init(|| async {
        let authority = admin();
        airdrop(&authority.pubkey(), 10_000_000_000).await;
        let mut init = InitZkConfigBuilder::new();
        init.authority(authority.pubkey())
            .config(config_address())
            .program_data(program_data())
            .admin(authority.pubkey())
            .pauser(authority.pubkey())
            .current(KeyHashes {
                vk: *vk::VK.sha256,
                pk: [1; 32],
                dump: [2; 32],
                ccs: [3; 32],
            });
        send_as(&authority, &[program().target(init.instruction())]).await;
        let mut mint = SetZkMintBuilder::new();
        mint.admin(authority.pubkey())
            .config(config_address())
            .mint(cluster().mint)
            .zk_mint(mint_address())
            .global_cap(GLOBAL_CAP)
            .lock_cap(LOCK_CAP)
            .record_fee(RECORD_FEE)
            .fee_account(fee_account().await);
        send_as(&authority, &[program().target(mint.instruction())]).await;
    })
    .await;
}

/// Replaces the caps of the mint; the fee stays.
pub async fn set_caps(global_cap: u64, lock_cap: u64) {
    let authority = admin();
    let mut mint = SetZkMintBuilder::new();
    mint.admin(authority.pubkey())
        .config(config_address())
        .mint(cluster().mint)
        .zk_mint(mint_address())
        .global_cap(global_cap)
        .lock_cap(lock_cap)
        .record_fee(RECORD_FEE)
        .fee_account(fee_account().await);
    send_as(&authority, &[program().target(mint.instruction())]).await;
}

pub const GLOBAL_CAP: u64 = 1_000_000_000_000;
pub const LOCK_CAP: u64 = 100_000_000_000;

pub async fn set_paused(paused: bool) {
    let authority = admin();
    let mut builder = SetZkPausedBuilder::new();
    builder
        .signer(authority.pubkey())
        .config(config_address())
        .paused(paused);
    send_as(&authority, &[program().target(builder.instruction())]).await;
}
