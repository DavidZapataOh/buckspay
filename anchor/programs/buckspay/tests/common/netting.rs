//! Netting records in the harness: the Go fixtures, the members' ephemeral keys, the Ed25519 instruction in the
//! one layout the program accepts, and the record and close instructions.
use super::zk::*;
use super::*;
use anchor_lang::{InstructionData, ToAccountMetas};
use buckspay_protocol::netting::{NettingStatement, MAX_PARTICIPANTS};
use ed25519_dalek::{Signer as _, SigningKey};
use serde::Deserialize;

pub const KEEP: u32 = buckspay::NETTING_KEEP_SECS;
pub type Entry = ([u8; 32], [u8; 64]);

#[derive(Deserialize)]
struct File {
    vk_sha256: String,
    cases: Vec<CaseFile>,
}

#[derive(Deserialize)]
struct CaseFile {
    name: String,
    statement: String,
    proof: String,
}

#[derive(Clone)]
pub struct Case {
    pub statement: NettingStatement,
    pub proof: [u8; 256],
}

/// The fixture named `name` (Task 1 §1.4: `n2`, `n5`, `n8`, `expired`, `on_curve`, …), proved under the compiled
/// key. Every statement byte is bound by the proof, so the generator, not the test, chose an expiry that gives the
/// address the case needs.
pub fn named(name: &str) -> Case {
    let f: File = serde_json::from_str(include_str!("../fixtures/netting_proofs.json")).unwrap();
    assert_eq!(
        f.vk_sha256,
        hex::encode(buckspay_zk_verify::vk::NETTING_VK.sha256)
    );
    f.cases
        .into_iter()
        .find(|c| c.name == name)
        .map(|c| Case {
            statement: NettingStatement::decode(&hex::decode(c.statement).unwrap()).unwrap(),
            proof: hex::decode(c.proof).unwrap().try_into().unwrap(),
        })
        .expect("fixture")
}

/// The example netting among `n` members (n = 2, 5 or 8); its record address is off the curve.
pub fn case(n: u8) -> Case {
    named(&format!("n{n}"))
}

/// Member `p`'s ephemeral key: the seeds the Go fixtures use.
pub fn member(p: usize) -> SigningKey {
    SigningKey::from_bytes(&[0x40 + p as u8; 32])
}

pub fn outsider(p: usize) -> SigningKey {
    SigningKey::from_bytes(&[0x60 + p as u8; 32])
}

pub fn body(s: &NettingStatement) -> Vec<u8> {
    let mut out = [0u8; 111 + 32 * MAX_PARTICIPANTS];
    let len = s.encode(&mut out);
    out[..len].to_vec()
}

pub fn message(s: &NettingStatement) -> [u8; 96] {
    s.envelope(&buckspay::netting_domain())
}

pub fn signed_by(keys: &[SigningKey], message: &[u8]) -> Vec<Entry> {
    keys.iter()
        .map(|k| (k.verifying_key().to_bytes(), k.sign(message).to_bytes()))
        .collect()
}

pub fn members(n: u8) -> Vec<SigningKey> {
    (0..usize::from(n)).map(member).collect()
}

/// The Ed25519 instruction the program accepts: one entry per member with every instruction index `u16::MAX`,
/// the keys and signatures inline, one shared message at the end.
pub fn ed25519_multi(entries: &[Entry], message: &[u8]) -> Instruction {
    ed25519_multi_at(entries, message, u16::MAX)
}

/// The same layout whose offsets read the instruction at `index` instead of this one.
pub fn ed25519_multi_at(entries: &[Entry], message: &[u8], index: u16) -> Instruction {
    let n = entries.len();
    let base = 2 + 14 * n;
    let msg_off = base + 96 * n;
    let mut data = vec![n as u8, 0];
    for i in 0..n {
        let key_off = base + 96 * i;
        for field in [
            key_off + 32,
            usize::from(index),
            key_off,
            usize::from(index),
            msg_off,
            message.len(),
            usize::from(index),
        ] {
            data.extend_from_slice(&(field as u16).to_le_bytes());
        }
    }
    for (key, signature) in entries {
        data.extend_from_slice(key);
        data.extend_from_slice(signature);
    }
    data.extend_from_slice(message);
    Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data,
    }
}

/// The record address of `content`, or a fixed unrelated address when it is on the curve: such a statement is
/// refused before its address is used (the `on_curve` fixture tests that refusal).
pub fn netting_address(content: &[u8; 32]) -> Pubkey {
    Pubkey::create_program_address(&[b"netting", content, &[255]], &buckspay::ID)
        .unwrap_or(Pubkey::new_from_array([0xee; 32]))
}

pub fn record_ix(
    payer: &Pubkey,
    netting: &Pubkey,
    statement: &[u8],
    proof: &[u8; 256],
) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::RecordNetting {
            payer: *payer,
            netting: *netting,
            instructions: solana_instructions_sysvar::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::RecordNetting {
            statement: statement.to_vec(),
            proof: *proof,
        }
        .data(),
    }
}

pub fn close_ix(netting: &Pubkey, payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::CloseNetting {
            netting: *netting,
            payer: *payer,
        }
        .to_account_metas(None),
        data: buckspay::instruction::CloseNetting {}.data(),
    }
}

/// An honest record of `s` paid by `payer`: every member signs the statement's envelope.
pub fn record_ixs(payer: &Pubkey, s: &NettingStatement, proof: &[u8; 256]) -> Vec<Instruction> {
    signed_record(payer, s, proof, &members(s.participants))
}

pub fn signed_record(
    payer: &Pubkey,
    s: &NettingStatement,
    proof: &[u8; 256],
    keys: &[SigningKey],
) -> Vec<Instruction> {
    let m = message(s);
    vec![
        ed25519_multi(&signed_by(keys, &m), &m),
        record_ix(payer, &netting_address(&s.content()), &body(s), proof),
    ]
}
