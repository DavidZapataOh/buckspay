//! Sizes and compute units of settlement and reclaim, for the formats a wallet can sign (legacy and
//! v0 with a lookup table) and for transaction v1.
mod common;
use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction};
use buckspay_protocol::{Owner, NO_LOCK};
use common::*;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_message::{v0, v1, AddressLookupTableAccount, VersionedMessage};
use solana_signer::Signer;

const LIMIT: usize = 1_232;

fn legacy_size(payer: &Pubkey, ixs: &[Instruction]) -> usize {
    let m = solana_message::Message::new_with_blockhash(ixs, Some(payer), &Default::default());
    1 + 64 + VersionedMessage::Legacy(m).serialize().len()
}

fn v0_size(payer: &Pubkey, ixs: &[Instruction], table: &[Pubkey]) -> usize {
    let alt = AddressLookupTableAccount {
        key: Pubkey::new_unique(),
        addresses: table.to_vec(),
    };
    let m = v0::Message::try_compile(payer, ixs, &[alt], Default::default()).unwrap();
    1 + 64 + VersionedMessage::V0(m).serialize().len()
}

fn v1_size(payer: &Pubkey, ixs: &[Instruction]) -> usize {
    let config = v1::TransactionConfig {
        compute_unit_limit: Some(200_000),
        loaded_accounts_data_size_limit: Some(64 * 1024),
        priority_fee: Some(1_000),
        ..v1::TransactionConfig::empty()
    };
    let m = v1::Message::try_compile_with_config(payer, ixs, Default::default(), config).unwrap();
    VersionedMessage::V1(m).serialize().len() + 64
}

/// What a wallet that adds its own compute-budget instructions does to a transaction.
fn with_budget(ixs: &[Instruction]) -> Vec<Instruction> {
    let mut all = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(200_000),
        ComputeBudgetInstruction::set_compute_unit_price(1_000),
    ];
    all.extend(ixs.iter().cloned());
    all
}

fn with_limit(ixs: &[Instruction]) -> Vec<Instruction> {
    let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(200_000)];
    all.extend(ixs.iter().cloned());
    all
}

/// The addresses that every settlement names and that are the same for every issuer: the lookup
/// table a wallet-signed transaction can use.
fn shared_table(env: &Env) -> Vec<Pubkey> {
    vec![
        anchor_spl::token::ID,
        solana_sdk_ids::system_program::ID,
        solana_instructions_sysvar::ID,
        env.mint,
    ]
}

fn row(name: &str, payer: &Pubkey, ixs: &[Instruction], table: &[Pubkey], wide: &[Pubkey]) {
    let budget = with_budget(ixs);
    let sizes = [
        legacy_size(payer, ixs),
        legacy_size(payer, &with_limit(ixs)),
        legacy_size(payer, &budget),
        v0_size(payer, ixs, table),
        v0_size(payer, &budget, table),
        v0_size(payer, &budget, wide),
        v1_size(payer, ixs),
    ];
    let fits = |s: usize| if s <= LIMIT { "fits" } else { "NO" };
    eprintln!(
        "{name}: legacy {} B ({}) | +limit {} | +limit+price {} ({}) | v0+ALT4 {} | +limit+price {} ({}) | v0+ALT8 +limit+price {} ({}) | v1 {}",
        sizes[0], fits(sizes[0]), sizes[1], sizes[2], fits(sizes[2]), sizes[3], sizes[4], fits(sizes[4]), sizes[5], fits(sizes[5]), sizes[6]
    );
}

struct Fixture {
    env: Env,
    issuer: Issuer,
    holder: Key,
    payee: Pubkey,
    dest: Pubkey,
    expiry: u32,
}

fn fixture() -> Fixture {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, 1_000_000_000, 60);
    let payee = Pubkey::new_unique();
    let dest = env.token_account_of(&payee, 0);
    let expiry = expiry_of(&env, 10);
    Fixture {
        env,
        issuer,
        holder: Key::new(2),
        payee,
        dest,
        expiry,
    }
}

impl Fixture {
    fn base(&self) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            0,
            90_000_000,
            self.holder.owner(),
            caveats(self.expiry, 12),
        )
    }
    /// A settlement of `n` spends: `n - 1` payments with change, then the settlement from the change.
    fn chain(&self, n: usize) -> Chain {
        if n == 0 {
            return Chain::issue(
                &self.issuer.key,
                &self.env.mint,
                0,
                0,
                1_000_000,
                Owner::Account(self.payee.to_bytes()),
                caveats(self.expiry, 12),
            );
        }
        let mut c = self.base();
        for i in 0..n - 1 {
            c = c.spend2(
                &self.holder,
                if i == 0 { 0 } else { 1 },
                Owner::Account(Pubkey::new_unique().to_bytes()),
                1_000_000,
                0,
                i as u8,
            );
        }
        c.spend1_to_account(
            &self.holder,
            if n == 1 { 0 } else { 1 },
            &self.payee,
            NO_LOCK,
            99,
        )
    }
}

#[test]
fn sizes_by_chain_length_and_format() {
    let f = fixture();
    let payer = f.env.payer.pubkey();
    let table = shared_table(&f.env);
    let mut wide = table.clone();
    wide.extend([
        f.issuer.lock,
        ledger_address(&f.issuer.lock),
        escrow_address(&f.issuer.lock),
        f.dest,
    ]);
    for n in 0..=7 {
        let chain = f.chain(n);
        let ixs = settle_ixs(&f.env, &payer, &f.issuer, &chain, &f.dest);
        row(&format!("settle n={n}"), &payer, &ixs, &table, &wide);
    }
    // A reclaim of the change of a chain of n spends.
    for n in [0usize, 1, 2, 6] {
        let mut c = f.base();
        for i in 0..n {
            c = c.spend2(
                &f.holder,
                if i == 0 { 0 } else { 1 },
                Owner::Account(Pubkey::new_unique().to_bytes()),
                1_000_000,
                0,
                i as u8,
            );
        }
        let which = u8::from(n > 0);
        let ixs = reclaim_ixs(
            &f.env,
            &payer,
            &f.issuer,
            &c,
            which,
            &f.holder,
            &f.issuer.wallet_token,
        );
        row(&format!("reclaim n={n}"), &payer, &ixs, &table, &wide);
    }
}

/// The two-transaction path of a wallet that pays for itself: record the consumed outputs but the
/// last, then settle with the last signature only.
#[test]
fn sizes_of_the_two_transaction_path() {
    let f = fixture();
    let payer = f.env.payer.pubkey();
    let table = shared_table(&f.env);
    let wide = table.clone();
    for n in 2..=5 {
        let chain = f.chain(n);
        let first = record_prefix_ixs(&payer, &f.issuer, &chain.prefix(n - 1), 0);
        let second = settle_ixs_resumed(&f.env, &payer, &f.issuer, &chain, &f.dest, n);
        row(
            &format!("n={n} step 1, record_prefix of {} spends", n - 1),
            &payer,
            &first,
            &table,
            &wide,
        );
        row(
            &format!("n={n} step 2, settlement with the last signature"),
            &payer,
            &second,
            &table,
            &wide,
        );
    }
}

/// 40 fresh chains (new payees, so new output ids), reported as min / median / max: with a fixed
/// bump for every record address the units do not depend on the ids, and what is left (a few tens
/// of CU) is the early exit of key comparisons on random keys. With a search for the bump
/// they differed by about 1,500 CU for each bump that failed.
fn sampled(mut run: impl FnMut() -> u64) -> (u64, u64, u64) {
    let mut units: Vec<u64> = (0..40).map(|_| run()).collect();
    units.sort_unstable();
    let spread = (units[0], units[units.len() / 2], units[units.len() - 1]);
    assert!(
        spread.2 - spread.0 <= 100,
        "the units do not depend on the output ids: {spread:?}"
    );
    spread
}

#[test]
fn units_by_chain_length_in_v1() {
    let mut previous = 0;
    for n in 0..=7usize {
        let (low, median, high) = sampled(|| {
            let mut f = fixture();
            let chain = f.chain(n);
            let payer = f.env.payer.pubkey();
            let ixs = settle_ixs(&f.env, &payer, &f.issuer, &chain, &f.dest);
            let landed = f.env.send_v1(&ixs).unwrap();
            assert!(landed.size <= 4_096);
            landed.units
        });
        eprintln!(
            "v1 settle n={n}: CU min {low} / median {median} / max {high} (median +{} over n-1)",
            median.saturating_sub(previous)
        );
        assert!(high <= 100_000);
        previous = median;
    }
    for n in [0usize, 1, 2, 6] {
        let (low, median, high) = sampled(|| {
            let mut f = fixture();
            // The owner is the issuer's own registered device.
            let me = &f.issuer.key;
            let mut c = Chain::issue(
                me,
                &f.env.mint,
                0,
                0,
                90_000_000,
                me.owner(),
                caveats(f.expiry, 12),
            );
            for i in 0..n {
                c = c.spend2(
                    me,
                    if i == 0 { 0 } else { 1 },
                    Owner::Account(Pubkey::new_unique().to_bytes()),
                    1_000_000,
                    0,
                    i as u8,
                );
            }
            let payer = f.env.payer.pubkey();
            f.env
                .warp(i64::from(f.expiry) + i64::from(buckspay_protocol::GRACE) + 1);
            let ixs = reclaim_ixs(
                &f.env,
                &payer,
                &f.issuer,
                &c,
                u8::from(n > 0),
                me,
                &f.issuer.wallet_token,
            );
            f.env.send_v1(&ixs).unwrap().units
        });
        eprintln!("v1 reclaim n={n}: CU min {low} / median {median} / max {high}");
    }
}

#[test]
fn units_of_the_legacy_transactions_and_the_two_transaction_path() {
    let (low, median, high) = sampled(|| {
        let mut f = fixture();
        let chain = f.chain(1);
        let payer = f.env.payer.pubkey();
        let landed = f
            .env
            .submit(&settle_ixs(&f.env, &payer, &f.issuer, &chain, &f.dest))
            .unwrap();
        assert!(landed.size <= LIMIT);
        landed.units
    });
    eprintln!("legacy settlement n=1: CU min {low} / median {median} / max {high}");
    assert!(high <= 40_000);
    let mut sizes = (0, 0);
    let mut second_units = vec![];
    let (low, median, high) = sampled(|| {
        let mut f = fixture();
        let chain = f.chain(2);
        let payer = f.env.payer.pubkey();
        f.env.svm.expire_blockhash();
        let first = f
            .env
            .submit(&record_prefix_ixs(&payer, &f.issuer, &chain.prefix(1), 0))
            .unwrap();
        f.env.svm.expire_blockhash();
        let second = f
            .env
            .submit(&settle_ixs_resumed(
                &f.env, &payer, &f.issuer, &chain, &f.dest, 2,
            ))
            .unwrap();
        sizes = (first.size, second.size);
        second_units.push(second.units);
        first.units
    });
    second_units.sort_unstable();
    eprintln!(
        "two transactions, n=2: record_prefix CU min {low} / median {median} / max {high}, {} B; settlement CU min {} / median {} / max {}, {} B",
        sizes.0, second_units[0], second_units[second_units.len() / 2], second_units[second_units.len() - 1], sizes.1
    );
    assert!(sizes.0 <= LIMIT && sizes.1 <= LIMIT);
}

fn settlement_under_limit(limit: u32) -> bool {
    let mut f = fixture();
    let chain = f.chain(1);
    let payer = f.env.payer.pubkey();
    let ixs = settle_ixs(&f.env, &payer, &f.issuer, &chain, &f.dest);
    f.env.send_v1_limited(&ixs, limit).is_ok()
}

/// The smallest `loaded_accounts_data_size_limit` under which the harness runtime lands a
/// settlement, against the sizes of the accounts the transaction names.
#[test]
fn the_loaded_accounts_limit_that_the_harness_runtime_needs() {
    let f = fixture();
    let chain = f.chain(1);
    let payer = f.env.payer.pubkey();
    let ixs = settle_ixs(&f.env, &payer, &f.issuer, &chain, &f.dest);
    let mut named: Vec<Pubkey> = ixs
        .iter()
        .flat_map(|ix| ix.accounts.iter().map(|a| a.pubkey).chain([ix.program_id]))
        .collect();
    named.push(payer);
    named.sort();
    named.dedup();
    let (mut with_programs, mut without) = (0usize, 0usize);
    for key in &named {
        let account = f.env.svm.get_account(key);
        let len = account.as_ref().map_or(0, |a| a.data.len());
        let program = account.as_ref().is_some_and(|a| a.executable);
        with_programs += 64 + len;
        if !program {
            without += 64 + len;
        }
        eprintln!(
            "  {key}: {len} B{}",
            if program { " (program)" } else { "" }
        );
    }
    let (mut low, mut high) = (1u32, 4 * 1024 * 1024);
    while low < high {
        let mid = low + (high - low) / 2;
        if settlement_under_limit(mid) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    eprintln!(
        "named accounts {}: 64 + data summed {with_programs} B with the programs, {without} B without; the harness lands from {low} B",
        named.len()
    );
}
