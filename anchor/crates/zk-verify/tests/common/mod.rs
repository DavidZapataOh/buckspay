#![allow(dead_code)]

use ark_bn254::{Fq, Fq2, Fr, G2Affine};
use ark_ec::short_weierstrass::SWCurveConfig;
use ark_ff::{BigInteger, Field, PrimeField};
use buckspay_protocol::hash::content;
use buckspay_zk_verify::{
    vk::{self, Vk},
    ChainContext, MessagePublic, Public, PROOF_COMPRESSED, PROOF_RAW,
};
use groth16_solana::groth16::{
    negate_g1_be, CommitmentVerifyingKey, Groth16Verifier, Groth16Verifyingkey,
};
use serde::Deserialize;
use std::str::FromStr;

/// The field modulus as 32 big-endian bytes.
pub const R_BYTES: [u8; 32] = buckspay_zk_verify::fr::MODULUS;

#[derive(Deserialize)]
struct ProofFile {
    cases: Vec<CaseFile>,
}

#[derive(Deserialize)]
struct CaseFile {
    proofs: Vec<ProofEntry>,
}

#[derive(Deserialize)]
struct ProofEntry {
    raw: String,
    compressed: String,
    public: Vec<String>,
    gnark_accepts: bool,
}

#[derive(Clone)]
pub struct Fixture {
    pub raw: Vec<[u8; PROOF_RAW]>,
    pub compressed: Vec<[u8; PROOF_COMPRESSED]>,
    pub publics: Vec<Public>,
    pub gnark_accepts: Vec<bool>,
}

fn public_of(entries: &[String]) -> Public {
    let mut out = [[0u8; 32]; 10];
    for (slot, hex_word) in out.iter_mut().zip(entries) {
        slot.copy_from_slice(&hex::decode(hex_word).expect("hex"));
    }
    out
}

pub fn fixture(name: &str) -> Fixture {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let file: ProofFile = serde_json::from_str(&std::fs::read_to_string(path).expect("fixture"))
        .expect("fixture json");
    let mut f = Fixture {
        raw: vec![],
        compressed: vec![],
        publics: vec![],
        gnark_accepts: vec![],
    };
    for p in &file.cases[0].proofs {
        f.raw.push(hex::decode(&p.raw).unwrap().try_into().unwrap());
        f.compressed
            .push(hex::decode(&p.compressed).unwrap().try_into().unwrap());
        f.publics.push(public_of(&p.public));
        f.gnark_accepts.push(p.gnark_accepts);
    }
    f
}

/// The key the fixtures were proved under.
pub fn test_vk() -> Vk<'static> {
    vk::VK
}

pub struct Negative {
    pub name: String,
    pub raw: [u8; PROOF_RAW],
    pub public: Public,
    pub gnark_accepts: bool,
}

#[derive(Deserialize)]
struct NegativeEntry {
    name: String,
    raw: String,
    public: Vec<String>,
    gnark_accepts: bool,
}

pub fn negatives() -> Vec<Negative> {
    let path = format!(
        "{}/tests/fixtures/negatives.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let entries: Vec<NegativeEntry> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
    entries
        .into_iter()
        .map(|e| Negative {
            name: e.name,
            raw: hex::decode(e.raw).unwrap().try_into().unwrap(),
            public: public_of(&e.public),
            gnark_accepts: e.gnark_accepts,
        })
        .collect()
}

fn oracle_vk(vk: &Vk) -> Groth16Verifyingkey<'static> {
    Groth16Verifyingkey {
        nr_pubinputs: 10,
        vk_alpha_g1: *vk.alpha_g1,
        vk_beta_g2: *vk.beta_g2,
        vk_gamma_g2: *vk.gamma_g2,
        vk_delta_g2: *vk.delta_g2,
        vk_ic: Box::leak(vk.ic.to_vec().into_boxed_slice()),
        vk_commitment: Some(CommitmentVerifyingKey {
            g2: *vk.commitment.expect("the chain key has a commitment").g,
            g_sigma_neg_g2: *vk
                .commitment
                .expect("the chain key has a commitment")
                .g_sigma_neg,
        }),
    }
}

pub fn groth16_solana_raw(vk: &Vk, raw: &[u8; PROOF_RAW], public: &Public) -> bool {
    let key = oracle_vk(vk);
    let a: [u8; 64] = raw[..64].try_into().unwrap();
    let neg_a = negate_g1_be(&a);
    let b: [u8; 128] = raw[64..192].try_into().unwrap();
    let c: [u8; 64] = raw[192..256].try_into().unwrap();
    let d: [u8; 64] = raw[256..320].try_into().unwrap();
    let pok: [u8; 64] = raw[320..384].try_into().unwrap();
    Groth16Verifier::<10>::new_with_commitment(&neg_a, &b, &c, &d, &pok, public, &key)
        .and_then(|mut v| v.verify())
        .is_ok()
}

pub fn groth16_solana_accepts(f: &Fixture, i: usize) -> bool {
    groth16_solana_raw(&test_vk(), &f.raw[i], &f.publics[i])
}

pub fn groth16_solana_accepts_raw(vk: &Vk, case: &Negative) -> bool {
    groth16_solana_raw(vk, &case.raw, &case.public)
}

/// A point of the curve of G2 that is not in the subgroup of order r.
pub struct OffSubgroup(G2Affine);

impl OffSubgroup {
    pub fn raw_be(&self) -> [u8; 128] {
        let mut out = [0u8; 128];
        let fq = |x: &Fq| x.into_bigint().to_bytes_be();
        out[..32].copy_from_slice(&fq(&self.0.x.c1));
        out[32..64].copy_from_slice(&fq(&self.0.x.c0));
        out[64..96].copy_from_slice(&fq(&self.0.y.c1));
        out[96..].copy_from_slice(&fq(&self.0.y.c0));
        out
    }

    pub fn compressed_be(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.0.x.c1.into_bigint().to_bytes_be());
        out[32..].copy_from_slice(&self.0.x.c0.into_bigint().to_bytes_be());
        let y = self.0.y;
        if y > -y {
            out[0] |= 0x80;
        }
        out
    }
}

pub fn g2_on_curve_off_subgroup() -> OffSubgroup {
    let b = ark_bn254::g2::Config::COEFF_B;
    for counter in 1u64.. {
        let x = Fq2::new(Fq::from(counter), Fq::from(1u64));
        let Some(y) = (x.square() * x + b).sqrt() else {
            continue;
        };
        let p = G2Affine::new_unchecked(x, y);
        if p.is_on_curve() && !p.is_in_correct_subgroup_assuming_on_curve() {
            return OffSubgroup(p);
        }
    }
    unreachable!()
}

// The cross-language vectors.

#[derive(Deserialize)]
pub struct Vectors {
    pub domain: String,
    pub valid: Vec<ValidChain>,
}

#[derive(Deserialize)]
pub struct ValidChain {
    pub name: String,
    pub messages: Vec<MessageEntry>,
    pub openings: Vec<OpeningEntry>,
    pub public: Vec<Vec<String>>,
}

#[derive(Deserialize)]
pub struct MessageEntry {
    pub body: String,
    pub key: String,
}

#[derive(Deserialize)]
pub struct OpeningEntry {
    pub amount: u64,
    pub index: u8,
}

pub fn vectors() -> Vectors {
    let path = format!(
        "{}/../../../prover/testdata/vectors.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("vectors json")
}

fn fr_bytes(decimal: &str) -> [u8; 32] {
    let x = if decimal.is_empty() {
        Fr::from(0u64)
    } else {
        Fr::from_str(decimal).expect("decimal")
    };
    x.into_bigint().to_bytes_be().try_into().unwrap()
}

/// The decimal form of a field element; the Go vectors write zero as an empty string or as 0.
pub fn dec(limb: &[u8; 32]) -> String {
    Fr::from_be_bytes_mod_order(limb).to_string()
}

pub fn normalized(decimal: &str) -> &str {
    if decimal.is_empty() {
        "0"
    } else {
        decimal
    }
}

/// What the wire carries for a chain of the vectors: the contents, the output bits, the state
/// commitments and the context. Nothing here comes from a signature or a key but the issuer's.
pub fn wire(chain: &ValidChain) -> (ChainContext, Vec<MessagePublic>) {
    let bodies: Vec<Vec<u8>> = chain
        .messages
        .iter()
        .map(|m| hex::decode(&m.body).unwrap())
        .collect();
    let issue = &bodies[0];
    let le64 = |b: &[u8]| u64::from_le_bytes(b.try_into().unwrap());
    let last = bodies.last().unwrap();
    let (pay_amount, expiry, payee) = if bodies.len() > 1 {
        let (owner, cav, amount) = match last.len() {
            82 => (
                &last[22..55],
                &last[55..82],
                chain.openings.last().unwrap().amount,
            ),
            _ => (&last[22..55], &last[63..90], le64(&last[55..63])),
        };
        let mut payee = [0u8; 32];
        payee.copy_from_slice(&owner[1..33]);
        (
            amount,
            u32::from_le_bytes(cav[..4].try_into().unwrap()),
            payee,
        )
    } else {
        (0, 0, [0u8; 32])
    };
    let ctx = ChainContext {
        domain: hex::decode(&vectors().domain).unwrap().try_into().unwrap(),
        issuer_key: issue[2..35].try_into().unwrap(),
        mint: issue[35..67].try_into().unwrap(),
        lock_seq: u32::from_le_bytes(issue[67..71].try_into().unwrap()),
        amount: le64(&issue[128..136]),
        cum_end: le64(&issue[71..79]),
        payee,
        pay_amount,
        expiry,
    };
    let n = bodies.len();
    let msgs = (0..n)
        .map(|i| MessagePublic {
            content: content(&bodies[i]),
            next_bit: chain.openings.get(i + 1).map_or(0, |o| o.index),
            s_out: fr_bytes(&chain.public[i][4]),
        })
        .collect();
    (ctx, msgs)
}
