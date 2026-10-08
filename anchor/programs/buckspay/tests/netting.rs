//! Netting records: the proof and every participant's signature are checked on chain, on both clusters' feature
//! sets, on the SBF binary.
mod common;
use buckspay::{BuckspayError, Netting};
use buckspay_protocol::netting::NettingStatement;
use common::netting::close_ix;
use common::netting::*;
use common::zk::*;
use common::*;
use ed25519_dalek::Signer as _;

fn each(test: impl Fn(&mut Zk)) {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        test(&mut Zk::new(cluster));
    }
}

fn refused(z: &mut Zk, ixs: Vec<Instruction>, error: BuckspayError) {
    let failed = z.send_ixs(&ixs).expect_err("the record must be refused");
    assert_eq!(failed.custom(), code_of(error), "{:?}", failed.error);
}

fn landed(z: &mut Zk, ixs: Vec<Instruction>) -> Landed {
    z.send_ixs(&ixs)
        .unwrap_or_else(|f| panic!("{:?}\n{}", f.error, z.env().logs()))
}

/// The fixture of `n` altered by `f`, with the fixture's proof: any alteration makes the proof or the signatures
/// fail before the address is used.
fn with(n: u8, f: impl FnOnce(&mut NettingStatement)) -> (NettingStatement, [u8; 256]) {
    let mut c = case(n);
    f(&mut c.statement);
    (c.statement, c.proof)
}

#[test]
fn records_valid_netting_n_2_5_8() {
    each(|z| {
        for n in [2, 5, 8] {
            let c = case(n);
            let gateway = z.gateway();
            let done = landed(z, record_ixs(&gateway, &c.statement, &c.proof));
            let now = z.env().now();
            let record: Netting = z.env().account(&netting_address(&c.statement.content()));
            let expires = c.statement.expires;
            assert_eq!(
                (record.payer, record.recorded_at, record.closable_at),
                (gateway, now, expires.saturating_add(KEEP))
            );
            eprintln!(
                "M4 {:?} n={n} cu={} bytes={}",
                z.cluster, done.units, done.size
            );
        }
    });
}

#[test]
fn record_fits_the_compute_and_size_budget() {
    each(|z| {
        let c = case(8);
        let gateway = z.gateway();
        let done = landed(z, record_ixs(&gateway, &c.statement, &c.proof));
        assert!(done.units <= 150_000, "{} CU", done.units);
        assert!(done.size <= 4_096, "{} bytes", done.size);
    });
}

#[test]
fn refuses_statements_the_proof_was_not_made_for() {
    type Alteration = (&'static str, fn(&mut NettingStatement));
    let alterations: [Alteration; 4] = [
        ("total", |s| s.total += 1),
        ("root", |s| s.root = case(5).statement.root),
        ("session", |s| s.session[0] ^= 1),
        ("participants", |s| s.participants -= 1),
    ];
    each(|z| {
        for (name, alter) in alterations {
            let (s, proof) = with(8, alter);
            let failed = z
                .send_ixs(&record_ixs(&z.gateway(), &s, &proof))
                .expect_err(name);
            assert_eq!(
                failed.custom(),
                code_of(BuckspayError::NettingProof),
                "{name}"
            );
        }
    });
}

#[test]
fn refuses_changed_mint_with_the_original_signatures() {
    each(|z| {
        let c = case(5);
        let mut ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
        let mut other = c.statement;
        other.mint[0] ^= 1;
        ixs[1] = record_ix(
            &z.gateway(),
            &netting_address(&other.content()),
            &body(&other),
            &c.proof,
        );
        refused(z, ixs, BuckspayError::NettingSignatures);
    });
}

#[test]
fn refuses_missing_extra_and_reordered_signatures() {
    each(|z| {
        let c = case(5);
        let m = message(&c.statement);
        let all = signed_by(&members(5), &m);
        let mut extra = all.clone();
        extra.extend(signed_by(&[member(7)], &m));
        let mut swapped = all.clone();
        swapped.swap(0, 1);
        for entries in [all[..4].to_vec(), extra, swapped] {
            let mut ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
            ixs[0] = ed25519_multi(&entries, &m);
            refused(z, ixs, BuckspayError::NettingSignatures);
        }
    });
}

#[test]
fn refuses_signatures_over_another_message() {
    each(|z| {
        let c = case(5);
        let other = with(5, |s| s.expires -= 1).0;
        let note = c.statement.envelope(&buckspay::note_domain());
        for m in [message(&other), note] {
            let mut ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
            ixs[0] = ed25519_multi(&signed_by(&members(5), &m), &m);
            refused(z, ixs, BuckspayError::NettingSignatures);
        }
    });
}

#[test]
fn refuses_signature_offsets_pointing_to_other_instruction() {
    each(|z| {
        let c = case(5);
        let m = message(&c.statement);
        let entries = signed_by(&members(5), &m);
        let mut ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
        // Instruction 0 verifies the bytes of instruction 2, which carries the same layout inline.
        ixs[0] = ed25519_multi_at(&entries, &m, 2);
        ixs.push(ed25519_multi(&entries, &m));
        refused(z, ixs, BuckspayError::NettingSignatures);
    });
}

#[test]
fn refuses_ed25519_not_at_current_minus_one() {
    each(|z| {
        let c = case(5);
        let honest = record_ixs(&z.gateway(), &c.statement, &c.proof);
        let unrelated = common::attesters::ed25519_ix(
            &member(7).verifying_key().to_bytes(),
            &member(7).sign(b"unrelated").to_bytes(),
            b"unrelated",
        );
        refused(
            z,
            vec![honest[0].clone(), unrelated, honest[1].clone()],
            BuckspayError::NettingSignatures,
        );
        refused(z, vec![honest[1].clone()], BuckspayError::NettingSignatures);
        refused(
            z,
            vec![honest[1].clone(), honest[0].clone()],
            BuckspayError::NettingSignatures,
        );
    });
}

#[test]
fn refuses_a_message_of_another_length() {
    each(|z| {
        let c = case(2);
        let mut m = message(&c.statement).to_vec();
        m.push(0);
        let mut ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
        ixs[0] = ed25519_multi(&signed_by(&members(2), &m), &m);
        refused(z, ixs, BuckspayError::NettingSignatures);
    });
}

#[test]
fn refuses_proof_bit_flip() {
    each(|z| {
        let c = case(5);
        for at in [1usize, 100, 200] {
            let mut proof = c.proof;
            proof[at] ^= 1;
            refused(
                z,
                record_ixs(&z.gateway(), &c.statement, &proof),
                BuckspayError::NettingProof,
            );
        }
    });
}

#[test]
fn refuses_malformed_statements() {
    each(|z| {
        let c = case(5);
        let mut noncanonical = c.statement;
        noncanonical.root = R_BYTES;
        let mut ixs = record_ixs(&z.gateway(), &noncanonical, &c.proof);
        refused(z, ixs.clone(), BuckspayError::NettingStatement);
        let mut short = body(&c.statement);
        short.pop();
        ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
        ixs[1] = record_ix(
            &z.gateway(),
            &netting_address(&c.statement.content()),
            &short,
            &c.proof,
        );
        refused(z, ixs, BuckspayError::NettingStatement);
    });
}

/// No pause on records (ARCH v4 D5, audit A2/L6): a record commits only what all n members signed, so a pause
/// would only void nettings in flight.
#[test]
fn record_ignores_zk_pause() {
    each(|z| {
        let pauser = z.pauser.insecure_clone();
        z.set_paused(&pauser, true).unwrap();
        let c = case(5);
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
    });
}

/// The chain record decides (ARCH v4 X2): strict `now < expires`.
#[test]
fn record_one_second_before_expires_lands() {
    each(|z| {
        let c = case(2);
        z.env().warp(i64::from(c.statement.expires) - 1);
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
    });
}

#[test]
fn record_at_exactly_expires_is_refused() {
    each(|z| {
        let c = case(2);
        z.env().warp(i64::from(c.statement.expires));
        refused(
            z,
            record_ixs(&z.gateway(), &c.statement, &c.proof),
            BuckspayError::NettingExpired,
        );
        z.env().warp(i64::from(c.statement.expires) + 3_600);
        refused(
            z,
            record_ixs(&z.gateway(), &c.statement, &c.proof),
            BuckspayError::NettingExpired,
        );
        let stale = named("expired");
        refused(
            z,
            record_ixs(&z.gateway(), &stale.statement, &stale.proof),
            BuckspayError::NettingExpired,
        );
    });
}

/// Inside [expires, closable_at) an absent account means void for every phone, so the keep window starts at
/// `expires`, not at the record time.
#[test]
fn closable_at_is_expires_plus_keep() {
    each(|z| {
        let c = case(8);
        z.env().warp(i64::from(c.statement.expires) - 3_600);
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
        let record: Netting = z.env().account(&netting_address(&c.statement.content()));
        assert_eq!(record.closable_at, c.statement.expires + KEEP);
        assert_eq!(record.recorded_at, c.statement.expires - 3_600);
    });
}

#[test]
fn refuses_a_second_record_of_the_same_content() {
    each(|z| {
        let c = case(5);
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
        refused(
            z,
            record_ixs(&z.gateway(), &c.statement, &c.proof),
            BuckspayError::NettingAddress,
        );
    });
}

#[test]
fn prefunded_address_is_still_recorded() {
    each(|z| {
        let c = case(5);
        let address = netting_address(&c.statement.content());
        let rent = z.env().rent(0);
        z.env().svm.airdrop(&address, rent).unwrap();
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
        assert_eq!(z.env().lamports(&address), z.env().rent(48));
    });
}

#[test]
fn refuses_an_address_on_the_curve_and_a_wrong_account() {
    each(|z| {
        let on_curve = named(if cfg!(feature = "short-windows") {
            "on_curve_short"
        } else {
            "on_curve"
        });
        assert!(Pubkey::create_program_address(
            &[b"netting", &on_curve.statement.content(), &[255]],
            &buckspay::ID
        )
        .is_err());
        refused(
            z,
            record_ixs(&z.gateway(), &on_curve.statement, &on_curve.proof),
            BuckspayError::NettingAddress,
        );
        let c = case(5);
        let other = netting_address(&case(2).statement.content());
        let mut ixs = record_ixs(&z.gateway(), &c.statement, &c.proof);
        ixs[1] = record_ix(&z.gateway(), &other, &body(&c.statement), &c.proof);
        refused(z, ixs, BuckspayError::NettingAddress);
    });
}

#[test]
fn records_with_member_as_payer() {
    each(|z| {
        let c = case(5);
        let wallet = z.env().funded_keypair();
        z.env()
            .send(
                &wallet,
                &record_ixs(&wallet.pubkey(), &c.statement, &c.proof),
            )
            .unwrap();
        let record: Netting = z.env().account(&netting_address(&c.statement.content()));
        assert_eq!(record.payer, wallet.pubkey());
    });
}

/// The session field binds the keys, the expiry and the mint (ARCH v3 §3.2): a published proof cannot be recorded
/// again under anything but its own statement (AUDIT-SURFACE C1, closed).
#[test]
fn replayed_proof_under_new_keys_refused() {
    each(|z| {
        let c = case(5);
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
        let keys: Vec<_> = (0..5).map(outsider).collect();
        let (replay, proof) = with(5, |s| {
            for (p, k) in keys.iter().enumerate() {
                s.ephemeral[p] = k.verifying_key().to_bytes();
            }
        });
        refused(
            z,
            signed_record(&z.gateway(), &replay, &proof, &keys),
            BuckspayError::NettingProof,
        );
    });
}

#[test]
fn replayed_proof_with_other_expires_refused() {
    each(|z| {
        let (replay, proof) = with(5, |s| s.expires -= 1);
        refused(
            z,
            record_ixs(&z.gateway(), &replay, &proof),
            BuckspayError::NettingProof,
        );
    });
}

#[test]
fn replayed_proof_with_other_mint_refused() {
    each(|z| {
        let (replay, proof) = with(5, |s| s.mint[0] ^= 1);
        refused(
            z,
            record_ixs(&z.gateway(), &replay, &proof),
            BuckspayError::NettingProof,
        );
    });
}

/// The member-paid fallback when a wallet refuses V1 (reconciliation §4): a two-member record fits a legacy or v0
/// transaction. The harness sends legacy; v0 without lookup tables is one byte larger, hence 1,231.
#[test]
fn member_paid_v0_for_two_participants() {
    each(|z| {
        let c = case(2);
        let wallet = z.env().funded_keypair();
        let done = z
            .env()
            .send(
                &wallet,
                &record_ixs(&wallet.pubkey(), &c.statement, &c.proof),
            )
            .unwrap();
        assert!(done.size <= 1_231, "{} bytes", done.size);
        eprintln!("M4 member_paid_legacy n=2 bytes={}", done.size);
    });
}

#[test]
fn closes_only_after_thirty_days_and_returns_rent_to_the_payer() {
    each(|z| {
        let c = case(5);
        let wallet = z.env().funded_keypair();
        z.env()
            .send(
                &wallet,
                &record_ixs(&wallet.pubkey(), &c.statement, &c.proof),
            )
            .unwrap();
        let address = netting_address(&c.statement.content());
        let record: Netting = z.env().account(&address);
        let stranger = z.stranger.insecure_clone();
        let early = z
            .send_as(&stranger, close_ix(&address, &wallet.pubkey()))
            .expect_err("too early");
        assert_eq!(early.custom(), code_of(BuckspayError::NettingOpen));
        z.env().warp(i64::from(record.closable_at));
        let wrong = z
            .send_as(&stranger, close_ix(&address, &stranger.pubkey()))
            .expect_err("not the payer");
        assert_eq!(
            wrong.custom(),
            anchor_lang::error::ErrorCode::ConstraintAddress as u32
        );
        let before = z.env().lamports(&wallet.pubkey());
        z.send_as(&stranger, close_ix(&address, &wallet.pubkey()))
            .unwrap();
        assert_eq!(
            z.env().lamports(&wallet.pubkey()),
            before + z.env().rent(48)
        );
        assert!(z
            .env()
            .svm
            .get_account(&address)
            .is_none_or(|a| a.lamports == 0));
    });
}

#[test]
fn a_record_moves_no_tokens() {
    each(|z| {
        let c = case(8);
        let tokens = |z: &mut Zk| {
            let program = z.env().token_program;
            let mut accounts = z.env().svm.get_program_accounts(&program);
            accounts.sort_by_key(|(address, _)| *address);
            accounts
                .into_iter()
                .map(|(a, account)| (a, account.lamports, account.data))
                .collect::<Vec<_>>()
        };
        let before = tokens(z);
        landed(z, record_ixs(&z.gateway(), &c.statement, &c.proof));
        assert_eq!(tokens(z), before);
        assert_eq!(z.env().invocations_of(&anchor_spl::token::ID), 0);
    });
}
