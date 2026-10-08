#![cfg(feature = "verify")]

use std::collections::BTreeSet;
use std::str::FromStr;

use buckspay_protocol::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};
use buckspay_protocol::hash::{content, domain, envelope, purpose};
use buckspay_protocol::iou::{cause, verify_co_signed, CoSigned, Iou, NettingJoin};
use buckspay_protocol::netting::{session_field, NettingStatement, BN254_R, MAX_PARTICIPANTS};
use buckspay_protocol::profile::{PRODUCTION_DEVNET_PROGRAM_ID, SHORT_PROGRAM_ID};
use buckspay_protocol::record::{netting_address, NETTING_SEED, RECORD_BUMP};
use buckspay_protocol::verify::verify_signature;
use buckspay_protocol::{kind, ProtocolError};
use ed25519_dalek::{Signer as _, SigningKey as EdKey, VerifyingKey as EdPublic};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PROGRAM: [u8; 32] = [0xb0; 32];

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn arr<const N: usize>(value: &Value) -> [u8; N] {
    unhex(value.as_str().unwrap()).try_into().unwrap()
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/v1.json")).unwrap()
}

struct Party {
    key: SigningKey,
    public: [u8; 33],
}

impl Party {
    fn new(seed: u8) -> Party {
        let key = SigningKey::from_slice(&[seed; 32]).unwrap();
        let public = key
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap();
        Party { key, public }
    }

    fn sign(&self, message: &[u8]) -> [u8; 64] {
        let signature: Signature = self.key.sign(message);
        signature.normalize_s().to_bytes().into()
    }
}

fn domain_of(purpose: &[u8]) -> [u8; 32] {
    domain(purpose, &DEVNET_GENESIS_HASH, &PROGRAM)
}

fn state(seq: u32, debtor: &Party, creditor: &Party, amount: u64) -> Iou {
    Iou {
        tab: [0x7a; 32],
        seq,
        debtor: debtor.public,
        creditor: creditor.public,
        mint: [3; 32],
        amount,
        due: 0,
        cause: cause::OPEN,
        reference: [0; 32],
        memo: [0; 32],
    }
}

fn co_sign(iou: Iou, debtor: &Party, creditor: &Party, under: &[u8; 32]) -> CoSigned {
    let message = iou.envelope(under);
    CoSigned {
        iou,
        debtor_sig: debtor.sign(&message),
        creditor_sig: creditor.sign(&message),
    }
}

fn ephemeral(seed: u8) -> [u8; 32] {
    EdKey::from_bytes(&[seed; 32]).verifying_key().to_bytes()
}

fn statement(n: u8, expires: u32) -> NettingStatement {
    let mut keys = [[0u8; 32]; MAX_PARTICIPANTS];
    for (i, key) in keys.iter_mut().take(usize::from(n)).enumerate() {
        *key = ephemeral(0x51 + i as u8);
    }
    let mut root = [0u8; 32];
    root[31] = 5;
    NettingStatement {
        session: [0x50 + n; 32],
        mint: [3; 32],
        participants: n,
        total: 1_000_000 * u64::from(n),
        expires,
        root,
        ephemeral: keys,
    }
}

fn be32(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

#[test]
fn iou_body_round_trips_and_matches_vector() {
    let v = &vectors()["iou"];
    let (devnet, mainnet) = (
        arr::<32>(&v["domain"]["devnet"]),
        arr::<32>(&v["domain"]["mainnet"]),
    );
    assert_eq!(devnet, domain(purpose::IOU, &DEVNET_GENESIS_HASH, &PROGRAM));
    assert_eq!(
        mainnet,
        domain(purpose::IOU, &MAINNET_GENESIS_HASH, &PROGRAM)
    );
    let states = v["states"].as_array().unwrap();
    assert!(states.len() >= 4);
    let mut ious = Vec::new();
    for s in states {
        let name = s["name"].as_str().unwrap();
        let body = unhex(s["body"].as_str().unwrap());
        let iou = Iou::decode_body(&body).unwrap();
        assert_eq!(body.len(), Iou::BODY_LEN);
        assert_eq!(body[1], kind::IOU);
        assert_eq!(iou.body().to_vec(), body, "{name}");
        assert_eq!(iou.slot(), arr::<32>(&s["slot"]), "{name}");
        assert_eq!(content(&body), arr::<32>(&s["content"]), "{name}");
        assert_eq!(
            iou.envelope(&devnet).to_vec(),
            unhex(s["envelope"]["devnet"].as_str().unwrap())
        );
        assert_eq!(
            iou.envelope(&mainnet).to_vec(),
            unhex(s["envelope"]["mainnet"].as_str().unwrap())
        );
        let wire = unhex(s["wire"].as_str().unwrap());
        let signed = CoSigned::decode(&wire).unwrap();
        assert_eq!(signed.iou, iou);
        assert_eq!(signed.encode().to_vec(), wire);
        assert_eq!(signed.debtor_sig, arr::<64>(&s["debtor_sig"]));
        assert_eq!(signed.creditor_sig, arr::<64>(&s["creditor_sig"]));
        verify_co_signed(&devnet, &signed).unwrap();
        assert_eq!(
            verify_co_signed(&mainnet, &signed),
            Err(ProtocolError::Signature),
            "{name}"
        );
        ious.push(iou);
    }
    let causes: BTreeSet<u8> = ious.iter().map(|i| i.cause).collect();
    assert_eq!(
        causes,
        BTreeSet::from([cause::OPEN, cause::REPAY, cause::OUTSIDE])
    );
    assert!(
        ious.iter().all(|i| i.amount >= 1),
        "every state is a change"
    );
    assert!(
        ious.windows(2).any(|w| w[0].debtor == w[1].creditor),
        "a change in the other direction"
    );
    let owed: i128 = ious
        .iter()
        .filter(|i| i.cause != cause::REPAY)
        .map(|i| {
            let signed = if i.cause == cause::OPEN {
                i128::from(i.amount)
            } else {
                -i128::from(i.amount)
            };
            if i.debtor == ious[0].debtor {
                signed
            } else {
                -signed
            }
        })
        .sum();
    assert_eq!(
        owed, -10_000_000,
        "Open 25 − Outside 10 + Open 5 − Outside 30: the direction flipped as two changes"
    );
    assert!(
        ious.windows(2).any(|w| w[1].seq > w[0].seq + 1),
        "a gap in seq"
    );
    // every Open/Outside names the content of the state before it as its predecessor (the first names none)
    assert_eq!(ious[0].reference, [0; 32]);
    for pair in ious.windows(2) {
        if pair[1].cause != cause::REPAY {
            assert_eq!(
                pair[1].reference,
                content(&pair[0].body()),
                "predecessor of seq {}",
                pair[1].seq
            );
        }
    }
    let alternatives = &v["alternatives"];
    let predecessor = arr::<32>(&alternatives["predecessor"]);
    let pair: Vec<CoSigned> = alternatives["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| CoSigned::decode(&unhex(w.as_str().unwrap())).unwrap())
        .collect();
    assert_eq!(pair.len(), 2);
    for alternative in &pair {
        verify_co_signed(&devnet, alternative).unwrap();
        assert_eq!(alternative.iou.reference, predecessor);
        assert_ne!(alternative.iou.cause, cause::REPAY);
    }
    assert_eq!(predecessor, content(&ious.last().unwrap().body()));
    assert_eq!(
        alternatives["counted_seq"].as_u64(),
        Some(u64::from(pair[0].iou.seq.max(pair[1].iou.seq)))
    );
    for pair in ious.windows(2) {
        pair[1].follows(&pair[0]).unwrap();
    }
}

#[test]
fn iou_slot_changes_with_seq() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let first = state(1, &a, &b, 10);
    assert_eq!(
        first.slot(),
        sha256(&[b"IOUS", &[0x7a; 32], &1u32.to_le_bytes()])
    );
    assert_ne!(first.slot(), state(2, &a, &b, 10).slot());
    assert_ne!(
        first.slot(),
        Iou {
            tab: [0x7b; 32],
            ..first
        }
        .slot()
    );
    let other_amount = Iou {
        amount: 11,
        ..first
    };
    assert_eq!(
        other_amount.slot(),
        first.slot(),
        "the slot names the place, the content names the body"
    );
    assert_ne!(
        other_amount.envelope(&domain_of(purpose::IOU)),
        first.envelope(&domain_of(purpose::IOU))
    );
}

#[test]
fn follows_accepts_gap() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let first = state(1, &a, &b, 10);
    let ninth = state(9, &a, &b, 3);
    ninth.follows(&first).unwrap();
    let flipped = state(10, &b, &a, 4);
    flipped.follows(&ninth).unwrap();
    let cleared = Iou {
        cause: cause::OUTSIDE,
        ..state(11, &b, &a, 1)
    };
    cleared.follows(&flipped).unwrap();
    assert_eq!(state(u32::MAX, &a, &b, 1).follows(&cleared), Ok(()));
}

#[test]
fn follows_refuses_non_increasing_swap_foreign_mint() {
    let (a, b, c) = (Party::new(0xd1), Party::new(0xc1), Party::new(0xe1));
    let previous = state(5, &a, &b, 10);
    let cases = [
        ("same seq", state(5, &a, &b, 11)),
        ("lower seq", state(4, &a, &b, 11)),
        (
            "other tab",
            Iou {
                tab: [0x7b; 32],
                ..state(6, &a, &b, 11)
            },
        ),
        (
            "other mint",
            Iou {
                mint: [4; 32],
                ..state(6, &a, &b, 11)
            },
        ),
        ("third party as creditor", state(6, &a, &c, 11)),
        ("third party as debtor", state(6, &c, &b, 11)),
    ];
    for (name, next) in cases {
        assert_eq!(
            next.follows(&previous),
            Err(ProtocolError::Linkage),
            "{name}"
        );
    }
}

#[test]
fn check_refuses_each_rule() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let ok = state(1, &a, &b, 1);
    assert_eq!(ok.check(), Ok(()), "the smallest change");
    let mut uncompressed = a.public;
    uncompressed[0] = 0x04;
    let cases = [
        ("seq 0", Iou { seq: 0, ..ok }, ProtocolError::Linkage),
        (
            "same parties",
            Iou {
                creditor: a.public,
                ..ok
            },
            ProtocolError::Owner,
        ),
        (
            "bad debtor prefix",
            Iou {
                debtor: uncompressed,
                ..ok
            },
            ProtocolError::Owner,
        ),
        (
            "bad creditor prefix",
            Iou {
                creditor: uncompressed,
                ..ok
            },
            ProtocolError::Owner,
        ),
        ("cause 0", Iou { cause: 0, ..ok }, ProtocolError::Kind),
        ("cause 5", Iou { cause: 5, ..ok }, ProtocolError::Kind),
        (
            "repay without reference",
            Iou {
                cause: cause::REPAY,
                ..ok
            },
            ProtocolError::Kind,
        ),
        (
            "netting cause, reserved",
            Iou {
                cause: cause::NETTING,
                reference: [9; 32],
                ..ok
            },
            ProtocolError::Kind,
        ),
        ("amount 0", Iou { amount: 0, ..ok }, ProtocolError::Amount),
        (
            "outside of 0",
            Iou {
                cause: cause::OUTSIDE,
                amount: 0,
                ..ok
            },
            ProtocolError::Amount,
        ),
    ];
    for (name, iou, error) in cases {
        assert_eq!(iou.check(), Err(error), "{name}");
        assert_eq!(
            Iou::decode_body(&iou.body()).map(|_| ()),
            Err(error),
            "{name} through decode"
        );
    }
    assert_eq!(
        Iou {
            cause: cause::REPAY,
            reference: [9; 32],
            ..ok
        }
        .check(),
        Ok(())
    );
    // a predecessor in an Open or Outside reference is valid
    assert_eq!(
        Iou {
            reference: [1; 32],
            ..ok
        }
        .check(),
        Ok(())
    );
    assert_eq!(
        Iou {
            cause: cause::OUTSIDE,
            reference: [1; 32],
            ..ok
        }
        .check(),
        Ok(())
    );
    assert_eq!(
        Iou {
            cause: cause::OUTSIDE,
            amount: u64::MAX,
            ..ok
        }
        .check(),
        Ok(())
    );
}

#[test]
fn decode_lengths_version_and_kind() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let body = state(1, &a, &b, 7).body();
    assert_eq!(
        Iou::decode_body(&body[..212]).map(|_| ()),
        Err(ProtocolError::Length)
    );
    let mut long = body.to_vec();
    long.push(0);
    assert_eq!(
        Iou::decode_body(&long).map(|_| ()),
        Err(ProtocolError::Length)
    );
    let mut version = body;
    version[0] = 2;
    assert_eq!(
        Iou::decode_body(&version).map(|_| ()),
        Err(ProtocolError::Version)
    );
    let mut join_kind = body;
    join_kind[1] = kind::NETTING_JOIN;
    assert_eq!(
        Iou::decode_body(&join_kind).map(|_| ()),
        Err(ProtocolError::Kind)
    );
}

#[test]
fn co_signed_wire_is_body_then_debtor_then_creditor() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let signed = co_sign(state(3, &a, &b, 7), &a, &b, &domain_of(purpose::IOU));
    let wire = signed.encode();
    assert_eq!(wire.len(), CoSigned::WIRE_LEN);
    assert_eq!(&wire[..213], &signed.iou.body()[..]);
    assert_eq!(&wire[213..277], &signed.debtor_sig[..]);
    assert_eq!(&wire[277..], &signed.creditor_sig[..]);
    assert_eq!(
        CoSigned::decode(&wire[..340]).map(|_| ()),
        Err(ProtocolError::Length)
    );
    let mut long = wire.to_vec();
    long.push(0);
    assert_eq!(
        CoSigned::decode(&long).map(|_| ()),
        Err(ProtocolError::Length)
    );
}

#[test]
fn one_sided_state_never_verifies() {
    let (a, b, c) = (Party::new(0xd1), Party::new(0xc1), Party::new(0xe1));
    let iou_domain = domain_of(purpose::IOU);
    let signed = co_sign(state(2, &a, &b, 9), &a, &b, &iou_domain);
    verify_co_signed(&iou_domain, &signed).unwrap();
    let message = signed.iou.envelope(&iou_domain);
    let cases = [
        (
            "debtor signed twice",
            CoSigned {
                creditor_sig: signed.debtor_sig,
                ..signed
            },
        ),
        (
            "creditor signed twice",
            CoSigned {
                debtor_sig: signed.creditor_sig,
                ..signed
            },
        ),
        (
            "swapped",
            CoSigned {
                debtor_sig: signed.creditor_sig,
                creditor_sig: signed.debtor_sig,
                ..signed
            },
        ),
        (
            "no creditor signature",
            CoSigned {
                creditor_sig: [0; 64],
                ..signed
            },
        ),
        (
            "a third key as creditor",
            CoSigned {
                creditor_sig: c.sign(&message),
                ..signed
            },
        ),
        (
            "signed for another body",
            CoSigned {
                iou: Iou {
                    amount: 10,
                    ..signed.iou
                },
                ..signed
            },
        ),
    ];
    for (name, state) in cases {
        assert!(verify_co_signed(&iou_domain, &state).is_err(), "{name}");
    }
}

#[test]
fn iou_signature_never_verifies_under_note_domain() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let iou_domain = domain_of(purpose::IOU);
    let signed = co_sign(state(1, &a, &b, 7), &a, &b, &iou_domain);
    verify_co_signed(&iou_domain, &signed).unwrap();
    for other in [
        purpose::NOTE,
        purpose::PAYWORD,
        purpose::NETTING,
        purpose::WITNESS,
    ] {
        let other = domain_of(other);
        assert_eq!(
            verify_co_signed(&other, &signed),
            Err(ProtocolError::Signature)
        );
    }
    let as_note = envelope(
        &domain_of(purpose::NOTE),
        &signed.iou.slot(),
        &content(&signed.iou.body()),
    );
    assert!(verify_signature(&a.public, &as_note, &signed.debtor_sig).is_err());
    let under_note = co_sign(signed.iou, &a, &b, &domain_of(purpose::NOTE));
    assert_eq!(
        verify_co_signed(&iou_domain, &under_note),
        Err(ProtocolError::Signature)
    );
}

#[test]
fn same_body_twice_and_both_parties_on_one_slot_are_not_equivocation() {
    let (a, b) = (Party::new(0xd1), Party::new(0xc1));
    let iou_domain = domain_of(purpose::IOU);
    let iou = state(4, &a, &b, 7);
    let message = iou.envelope(&iou_domain);
    verify_signature(&a.public, &message, &a.sign(&message)).unwrap();
    verify_signature(&a.public, &message, &a.sign(&message)).unwrap();
    verify_signature(&b.public, &message, &b.sign(&message)).unwrap();
    assert_ne!(
        iou.slot(),
        state(5, &a, &b, 7).slot(),
        "an update takes a new slot"
    );
    let netting = statement(2, 1_900_000_000).envelope(&domain_of(purpose::NETTING));
    assert_ne!(&netting[..], &message[..]);
}

#[test]
fn statement_carries_expires_in_content_not_public_inputs() {
    let a = statement(5, 1_900_000_000);
    let b = NettingStatement {
        expires: 1_900_000_001,
        ..a
    };
    assert_ne!(a.content(), b.content());
    let netting_domain = domain_of(purpose::NETTING);
    assert_ne!(a.envelope(&netting_domain), b.envelope(&netting_domain));
    // expires is no public input of its own: it reaches the proof only through session_field
    assert_ne!(a.public_inputs()[0], b.public_inputs()[0]);
    assert_eq!(a.public_inputs()[1..], b.public_inputs()[1..]);
    let inputs = a.public_inputs();
    assert_eq!(inputs[0], session_field(&a));
    assert_eq!(inputs[1], be32(5));
    assert_eq!(inputs[2], be32(5_000_000));
    assert_eq!(inputs[3], a.root);
    let mut body = [0u8; 111 + 32 * 8];
    let len = a.encode(&mut body);
    assert_eq!(
        u32::from_le_bytes(body[75..79].try_into().unwrap()),
        1_900_000_000
    );
    assert_eq!(a.content(), sha256(&[&body[..len]]));
    let env = a.envelope(&netting_domain);
    assert_eq!(&env[..32], &netting_domain[..]);
    assert_eq!(&env[32..64], &a.session[..]);
    assert_eq!(&env[64..], &a.content()[..]);
}

#[test]
fn join_slot_is_per_session() {
    let a = Party::new(0xd1);
    let first = NettingJoin {
        session: [0x5e; 32],
        ephemeral: ephemeral(0x51),
        key: a.public,
    };
    let second = NettingJoin {
        ephemeral: ephemeral(0x52),
        ..first
    };
    assert_eq!(
        first.slot(),
        second.slot(),
        "a second ephemeral key in one session takes the same slot"
    );
    assert_ne!(first.body(), second.body());
    assert_eq!(first.slot(), sha256(&[b"NETJ", &[0x5e; 32]]));
    assert_ne!(
        NettingJoin {
            session: [0x5f; 32],
            ..first
        }
        .slot(),
        first.slot()
    );
    let same_bytes_as_tab = Iou {
        tab: [0x5e; 32],
        ..state(1, &a, &Party::new(0xc1), 1)
    };
    assert_ne!(
        same_bytes_as_tab.slot(),
        first.slot(),
        "join and tab slots are tagged apart"
    );
    assert_eq!(first.body()[1], kind::NETTING_JOIN);
    assert_eq!(NettingJoin::decode_body(&first.body()), Ok(first));
    let iou_domain = domain_of(purpose::IOU);
    let v = &vectors()["nettingJoin"];
    for j in v["joins"].as_array().unwrap() {
        let body = unhex(j["body"].as_str().unwrap());
        let join = NettingJoin::decode_body(&body).unwrap();
        assert_eq!(join.body().to_vec(), body);
        assert_eq!(join.slot(), arr::<32>(&j["slot"]));
        let message = envelope(&iou_domain, &join.slot(), &content(&body));
        assert_eq!(message.to_vec(), unhex(j["envelope"].as_str().unwrap()));
        verify_signature(&join.key, &message, &arr::<64>(&j["signature"])).unwrap();
    }
}

#[test]
fn statement_encodes_n_2_5_8() {
    let v = &vectors()["netting"];
    let devnet = arr::<32>(&v["domain"]["devnet"]);
    let mainnet = arr::<32>(&v["domain"]["mainnet"]);
    assert_eq!(
        devnet,
        domain(purpose::NETTING, &DEVNET_GENESIS_HASH, &PROGRAM)
    );
    assert_eq!(
        mainnet,
        domain(purpose::NETTING, &MAINNET_GENESIS_HASH, &PROGRAM)
    );
    let production = solana_hash::Hash::from_str(PRODUCTION_DEVNET_PROGRAM_ID)
        .unwrap()
        .to_bytes();
    let short = solana_hash::Hash::from_str(SHORT_PROGRAM_ID)
        .unwrap()
        .to_bytes();
    let statements = v["statements"].as_array().unwrap();
    let ns: Vec<u64> = statements
        .iter()
        .map(|s| s["n"].as_u64().unwrap())
        .collect();
    assert_eq!(ns, [2, 5, 8]);
    for s in statements {
        let n = s["n"].as_u64().unwrap() as u8;
        let body = unhex(s["body"].as_str().unwrap());
        assert_eq!(body.len(), NettingStatement::body_len(n));
        assert_eq!(body.len(), 111 + 32 * usize::from(n));
        let decoded = NettingStatement::decode(&body).unwrap();
        let mut out = [0u8; 111 + 32 * 8];
        let len = decoded.encode(&mut out);
        assert_eq!(&out[..len], &body[..]);
        assert_eq!(decoded.content(), arr::<32>(&s["content"]));
        assert_eq!(
            decoded.envelope(&devnet).to_vec(),
            unhex(s["envelope"]["devnet"].as_str().unwrap())
        );
        assert_eq!(
            decoded.envelope(&mainnet).to_vec(),
            unhex(s["envelope"]["mainnet"].as_str().unwrap())
        );
        assert_eq!(session_field(&decoded), arr::<32>(&s["session_field"]));
        let expected: Vec<[u8; 32]> = s["public_inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(arr::<32>)
            .collect();
        assert_eq!(decoded.public_inputs().to_vec(), expected);
        for (program, key) in [(production, "production"), (short, "short")] {
            let address = netting_address(&program, &decoded.content());
            match &s["netting_address"][key] {
                Value::Null => assert_eq!(address, None),
                hex => assert_eq!(address, Some(arr::<32>(hex))),
            }
        }
        let message = decoded.envelope(&devnet);
        let signatures = s["signatures"].as_array().unwrap();
        assert_eq!(signatures.len(), usize::from(n));
        for (i, signature) in signatures.iter().enumerate() {
            let signature = arr::<64>(signature);
            let seed = EdKey::from_bytes(&[0x51 + i as u8; 32]);
            assert_eq!(
                seed.sign(&message).to_bytes(),
                signature,
                "deterministic Ed25519"
            );
            let public = EdPublic::from_bytes(&decoded.ephemeral[i]).unwrap();
            public
                .verify_strict(&message, &ed25519_dalek::Signature::from_bytes(&signature))
                .unwrap();
        }
    }
}

#[test]
fn statement_check_refuses_invalid() {
    let cases = vectors()["nettingInvalid"].as_array().unwrap().clone();
    let mut names = BTreeSet::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let body = unhex(case["body"].as_str().unwrap());
        let got = match case["type"].as_str().unwrap() {
            "iou" => Iou::decode_body(&body).map(|_| ()),
            "cosigned" => CoSigned::decode(&body).map(|_| ()),
            "follows" => {
                let previous =
                    Iou::decode_body(&unhex(case["previous"].as_str().unwrap())).unwrap();
                Iou::decode_body(&body).unwrap().follows(&previous)
            }
            "join" => NettingJoin::decode_body(&body).map(|_| ()),
            "statement" => NettingStatement::decode(&body).map(|_| ()),
            other => panic!("unknown case type {other}"),
        };
        assert_eq!(
            got.map_err(|e| format!("{e:?}")),
            Err(case["error"].as_str().unwrap().to_string()),
            "{name}"
        );
        names.insert(name.to_string());
    }
    for required in [
        "iou_short",
        "iou_version",
        "iou_kind",
        "iou_seq_zero",
        "iou_same_parties",
        "iou_bad_key_prefix",
        "iou_unknown_cause_0",
        "iou_unknown_cause_5",
        "iou_cause_netting",
        "iou_amount_zero",
        "iou_repay_without_reference",
        "cosigned_long",
        "follows_same_seq",
        "follows_lower_seq",
        "follows_other_tab",
        "follows_other_party",
        "follows_other_mint",
        "join_short",
        "join_bad_key",
        "statement_short",
        "statement_n_1",
        "statement_n_9",
        "statement_duplicate_key",
        "statement_root_r",
        "statement_version",
    ] {
        assert!(names.contains(required), "missing invalid case {required}");
    }
}

#[test]
fn statement_unused_entries_must_be_zero_and_root_below_r() {
    let mut s = statement(3, 1_900_000_000);
    assert_eq!(s.check(), Ok(()));
    s.ephemeral[5] = [1; 32];
    assert_eq!(s.check(), Err(ProtocolError::Length));
    let mut at_r = statement(3, 1_900_000_000);
    at_r.root = BN254_R;
    assert_eq!(at_r.check(), Err(ProtocolError::Amount));
    let mut below = BN254_R;
    below[31] -= 1;
    assert_eq!(
        NettingStatement {
            root: below,
            ..statement(3, 1)
        }
        .check(),
        Ok(())
    );
    let mut duplicate = statement(4, 1);
    duplicate.ephemeral[3] = duplicate.ephemeral[0];
    assert_eq!(duplicate.check(), Err(ProtocolError::Signer));
}

#[test]
fn session_field_is_canonical() {
    for i in 0..=255u8 {
        let n = 2 + i % 7;
        let s = NettingStatement {
            session: [i; 32],
            expires: u32::from(i) * 1_000,
            ..statement(n, 1)
        };
        let keys: Vec<u8> = s.ephemeral[..usize::from(n)].concat();
        let mut expected = sha256(&[
            b"BUCKSPAY:v1:netting-session",
            &s.session,
            &s.mint,
            &s.expires.to_le_bytes(),
            &[n],
            &keys,
        ]);
        expected[0] &= 0x1f;
        let field = session_field(&s);
        assert_eq!(field, expected);
        assert!(
            field < BN254_R,
            "big-endian byte order compares like the integer"
        );
        assert_eq!(s.public_inputs()[0], field);
    }
}

#[test]
fn session_field_binds_mint_expires_keys() {
    let base = statement(5, 1_900_000_000);
    let mut other_key = base;
    other_key.ephemeral[4] = ephemeral(0x60);
    let variants = [
        ("other key", other_key),
        (
            "other expires",
            NettingStatement {
                expires: base.expires + 1,
                ..base
            },
        ),
        (
            "other mint",
            NettingStatement {
                mint: [4; 32],
                ..base
            },
        ),
    ];
    for (name, changed) in variants {
        assert_ne!(session_field(&changed), session_field(&base), "{name}");
        assert_eq!(
            changed.public_inputs()[1..],
            base.public_inputs()[1..],
            "{name}: n, total, root unchanged"
        );
    }
    let v = &vectors()["nettingBinding"];
    let decode = |c: &Value| NettingStatement::decode(&unhex(c["body"].as_str().unwrap())).unwrap();
    let base = decode(&v["base"]);
    assert_eq!(session_field(&base), arr::<32>(&v["base"]["session_field"]));
    let mut fields = BTreeSet::from([session_field(&base)]);
    let cases = v["cases"].as_array().unwrap();
    let names: Vec<&str> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["other_key", "other_expires", "other_mint"]);
    for c in cases {
        let s = decode(c);
        assert_eq!(session_field(&s), arr::<32>(&c["session_field"]));
        assert_eq!(s.public_inputs()[1..], base.public_inputs()[1..]);
        fields.insert(session_field(&s));
    }
    assert_eq!(fields.len(), 4, "every binding case changes session_field");
}

#[test]
fn netting_address_none_on_curve() {
    assert_eq!(NETTING_SEED, &b"netting"[..]);
    let program = [7u8; 32];
    let (mut found, mut on_curve_seen) = (0, false);
    for n in 0u32..256 {
        let mut statement_content = [0u8; 32];
        statement_content[..4].copy_from_slice(&n.to_le_bytes());
        let expected = sha256(&[
            NETTING_SEED,
            &statement_content,
            &[RECORD_BUMP],
            &program,
            b"ProgramDerivedAddress",
        ]);
        let on_curve = curve25519_dalek::edwards::CompressedEdwardsY(expected)
            .decompress()
            .is_some();
        match netting_address(&program, &statement_content) {
            Some(address) => {
                assert!(!on_curve);
                assert_eq!(address, expected);
                found += 1;
            }
            None => {
                assert!(on_curve);
                on_curve_seen = true;
            }
        }
    }
    assert!(on_curve_seen);
    assert!(
        (100..160).contains(&found),
        "{found} of 256 are off the curve"
    );
}
