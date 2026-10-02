use litesvm::LiteSVM;
use p256::{
    ecdsa::{Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
};
use serde_json::Value;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_precompile_error::PrecompileError;
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError};

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/keys/fixtures/p256-der.json"
));

struct Case {
    name: String,
    message: Vec<u8>,
    der: Vec<u8>,
    spki: Vec<u8>,
    high_s: bool,
    compact: [u8; 64],
    sec1: [u8; 33],
}

fn hex(value: &Value) -> Vec<u8> {
    let text = value.as_str().unwrap();
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn cases() -> Vec<Case> {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| Case {
            name: c["name"].as_str().unwrap().to_owned(),
            message: hex(&c["message"]),
            der: hex(&c["der"]),
            spki: hex(&c["spki"]),
            high_s: c["high_s"].as_bool().unwrap(),
            compact: hex(&c["compact"]).try_into().unwrap(),
            sec1: hex(&c["sec1"]).try_into().unwrap(),
        })
        .collect()
}

struct Svm {
    svm: LiteSVM,
    payer: Keypair,
}

impl Svm {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        Self { svm, payer }
    }

    /// Verifies one signature through the precompile; returns (compute units, fee in lamports).
    fn verify(
        &mut self,
        message: &[u8],
        signature: &[u8; 64],
        key: &[u8; 33],
    ) -> Result<(u64, u64), TransactionError> {
        self.svm.expire_blockhash();
        let ix = new_secp256r1_instruction_with_signature(message, signature, key);
        let message = Message::new_with_blockhash(
            &[ix],
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&self.payer])
            .unwrap();
        let before = self.svm.get_balance(&self.payer.pubkey()).unwrap();
        let meta = self.svm.send_transaction(tx).map_err(|failed| failed.err)?;
        let after = self.svm.get_balance(&self.payer.pubkey()).unwrap();
        Ok((meta.compute_units_consumed, before - after))
    }
}

fn invalid_signature() -> Result<(u64, u64), TransactionError> {
    Err(TransactionError::InstructionError(
        0,
        InstructionError::Custom(PrecompileError::InvalidSignature as u32),
    ))
}

#[test]
fn keystore_signatures_pass_the_precompile_once_normalised() {
    let mut svm = Svm::new();
    for case in cases() {
        let raw = Signature::from_der(&case.der).unwrap();
        let low = raw.normalize_s();
        let key = VerifyingKey::from_public_key_der(&case.spki).unwrap();
        assert_eq!(
            <[u8; 64]>::from(low.to_bytes()),
            case.compact,
            "{}",
            case.name
        );
        assert_eq!(
            key.to_sec1_point(true).as_bytes(),
            case.sec1,
            "{}",
            case.name
        );
        assert_eq!(low != raw, case.high_s, "{}", case.name);

        let (units, fee) = svm
            .verify(&case.message, &case.compact, &case.sec1)
            .unwrap_or_else(|e| panic!("{}: {e:?}", case.name));
        assert_eq!((units, fee), (0, 10_000), "{}", case.name);
        if case.high_s {
            let raw = raw.to_bytes().into();
            assert_eq!(
                svm.verify(&case.message, &raw, &case.sec1),
                invalid_signature(),
                "{}",
                case.name
            );
        }
    }
}

#[test]
fn precompile_rejects_another_key_and_another_message() {
    let mut svm = Svm::new();
    let cases = cases();
    let (a, b) = (&cases[0], &cases[1]);
    assert_eq!(
        svm.verify(&a.message, &a.compact, &b.sec1),
        invalid_signature()
    );
    assert_eq!(
        svm.verify(&b.message, &a.compact, &a.sec1),
        invalid_signature()
    );
}
