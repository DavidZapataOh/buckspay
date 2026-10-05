use check_payouts::{check_manifest, check_program, check_source, Finding, Role};
use proptest::prelude::*;
use std::{fs, path::Path, process::Command};

fn run(role: Role, source: &str) -> Vec<Finding> {
    check_source(Path::new("src/test.rs"), source, role).expect("the test source parses")
}

fn assert_flagged(label: &str, source: &str) {
    let findings = run(Role::Program, source);
    assert!(!findings.is_empty(), "{label} was not flagged:\n{source}");
}

fn assert_clean(label: &str, role: Role, source: &str) {
    let findings = run(role, source);
    assert!(
        findings.is_empty(),
        "{label} was flagged: {findings:?}\n{source}"
    );
}

/// Every way a token transfer, burn, close or raw invocation can be written outside `payout.rs`.
const EVASIONS: &[(&str, &str)] = &[
    // The imports and calls a grep for transfer names misses.
    ("imported burn", "use anchor_spl::token_interface::burn; fn f(c: C) { burn(c, 1).unwrap(); }"),
    ("anchor_spl::token::transfer", "fn f(c: C) { anchor_spl::token::transfer(c, 1).unwrap(); }"),
    ("close_account", "use anchor_spl::token::close_account; fn f(c: C) { close_account(c).unwrap(); }"),
    ("raw invoke_signed", "use anchor_lang::solana_program::program::invoke_signed; fn f() { invoke_signed(&ix, &infos, &[]).unwrap(); }"),
    // Aliases and nesting.
    ("raw invoke_signed, fully qualified", "fn f() { anchor_lang::solana_program::program::invoke_signed(&ix, &[], &[]).unwrap(); }"),
    ("renamed function", "use anchor_spl::token_interface::transfer_checked as pay; fn f() { pay(c, 1, 6).unwrap(); }"),
    ("renamed module", "use anchor_spl::token_interface as ti; fn f() { ti::burn(c, 1).unwrap(); }"),
    ("self rename inside a group", "use anchor_spl::token_interface::{self as ti, Mint}; fn f() { ti::transfer_checked(c, 1, 6).unwrap(); }"),
    ("nested use groups", "use anchor_spl::{token::{self, Token}, token_interface::Mint}; fn f() { token::transfer(c, 1).unwrap(); }"),
    ("alias of an alias", "use anchor_spl::token as t; use t::transfer; fn f() { transfer(c, 1).unwrap(); }"),
    ("extern crate rename", "extern crate anchor_spl as spl; fn f() { spl::token::transfer(c, 1).unwrap(); }"),
    ("function pointer", "fn f() { let g = anchor_spl::token_interface::mint_to; g(c, 1).unwrap(); }"),
    ("function-local import", "fn f() { use anchor_spl::token::burn; burn(c, 1).unwrap(); }"),
    ("renamed raw invoke", "use anchor_lang::solana_program::program::invoke as go; fn f() { go(&ix, &[]).unwrap(); }"),
    ("renamed program module", "use anchor_lang::solana_program::program as p; fn f() { p::invoke(&ix, &[]).unwrap(); }"),
    // Globs.
    ("glob of a token module", "use anchor_spl::token_interface::*; fn f() { burn(c, 1).unwrap(); }"),
    ("glob of the program module", "use anchor_lang::solana_program::program::*; fn f() { invoke(&ix, &[]).unwrap(); }"),
    // Other crates and builders.
    ("CPI account struct", "use anchor_spl::token_interface::TransferChecked; fn f() { let a = TransferChecked { from: x, mint: y, to: z, authority: w }; }"),
    ("spl_token instruction builder", "fn f() { let ix = spl_token::instruction::transfer(&id, &a, &b, &c, &[], 1); }"),
    ("spl_token_2022 onchain helper", "fn f() { spl_token_2022::onchain::invoke_transfer_checked(&p, a, b, c, d, &[], 1, 6, &[]).unwrap(); }"),
    ("builder through the anchor_spl re-export", "fn f() { anchor_spl::token_2022::spl_token_2022::instruction::burn(&p, &a, &m, &o, &[], 1).unwrap(); }"),
    ("pinocchio builder", "use pinocchio_token::instructions::Transfer; fn f() { Transfer { from: &a, to: &b, authority: &c, amount: 1 }.invoke_signed(&[]).unwrap(); }"),
    ("method-style invoke", "fn f(t: T) { t.invoke_signed(&[]).unwrap(); }"),
    ("associated token create", "use anchor_spl::associated_token::create; fn f() { create(c).unwrap(); }"),
    ("solana_invoke crate", "use solana_invoke::invoke; fn f() {}"),
    ("unknown anchor_spl module", "use anchor_spl::newer::thing;"),
    // Hiding places.
    ("call inside a macro argument", "fn f() { require!(anchor_spl::token::transfer(c, 1).is_ok(), E::X); }"),
    ("alias used inside msg!", "use anchor_spl::token::burn; fn f() { msg!(\"{:?}\", burn(c, 1)); }"),
    ("account constraint expression", "#[derive(Accounts)] struct A { #[account(constraint = anchor_spl::token::transfer(c, 1).is_ok())] x: u8 }"),
    ("macro_rules taking the function as an argument", "macro_rules! call { ($f:ident) => { $f(c, 1) } }"),
    ("include!", "include!(\"other.rs\");"),
    ("#[path]", "#[path = \"elsewhere.rs\"] mod hidden;"),
    ("unsafe block", "fn f() { unsafe { sol_call(a, b); } }"),
    ("unsafe fn", "unsafe fn f() {}"),
    ("extern block", "extern \"C\" { fn sol_invoke_signed_rust(a: *const u8) -> u64; }"),
    ("re-export", "pub use anchor_spl::token::transfer as pay;"),
    ("nested module and closure", "mod inner { pub fn f() { let g = || anchor_spl::token::transfer(c, 1); } }"),
    ("inherent method", "impl A { fn run(&self) { anchor_spl::token_interface::close_account(c).unwrap(); } }"),
    ("trait default method", "trait T { fn run() { anchor_spl::token::burn(c, 1).unwrap(); } }"),
];

#[test]
fn every_evasion_outside_payout_is_flagged() {
    for (label, source) in EVASIONS {
        assert_flagged(label, source);
    }
}

#[test]
fn the_same_code_is_allowed_in_payout_rs() {
    for (label, source) in EVASIONS.iter().filter(|(label, _)| *label != "re-export") {
        let findings = run(Role::Payout, source);
        assert!(findings.is_empty(), "{label} in payout.rs: {findings:?}");
    }
}

#[test]
fn a_findings_line_points_at_the_offending_call() {
    let source = "use anchor_lang::prelude::*;\n\nfn f(c: C) {\n    let a = 1;\n    anchor_spl::token::transfer(c, a).unwrap();\n}\n";
    let findings = run(Role::Program, source);
    assert_eq!(findings.iter().map(|f| f.line).collect::<Vec<_>>(), vec![5]);
}

#[test]
fn ordinary_program_code_is_clean() {
    let clean: &[(&str, &str)] = &[
        (
            "a payout handler",
            "use anchor_lang::prelude::*;
             use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
             use crate::payout::{close_escrow, pay_out};
             pub fn withdraw<'info>(ledger: &mut Account<'info, Ledger>, escrow: &mut InterfaceAccount<'info, TokenAccount>) -> Result<()> {
                 let debit = ledger.drain(escrow.amount)?;
                 pay_out(ledger, &lock, escrow, &mint, &destination, &token_program, debit)?;
                 Ok(())
             }",
        ),
        (
            "an accounts context with token constraints",
            "use anchor_lang::prelude::*;
             use anchor_spl::token::{self, Token};
             use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
             #[derive(Accounts)]
             pub struct W<'info> {
                 #[account(mut, token::mint = mint, token::authority = ledger, token::token_program = token_program)]
                 pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
                 pub token_program: Interface<'info, TokenInterface>,
                 pub legacy: Program<'info, Token>,
             }",
        ),
        (
            "a system-program transfer of lamports",
            "use anchor_lang::{prelude::*, system_program::{transfer, Transfer}};
             fn sweep<'info>(sys: &Program<'info, System>, from: AccountInfo<'info>, to: AccountInfo<'info>, seeds: &[&[u8]]) -> Result<()> {
                 transfer(CpiContext::new_with_signer(sys.key(), Transfer { from, to }, &[seeds]), 5)
             }",
        ),
        (
            "mint extension validation",
            "use anchor_spl::token_2022::spl_token_2022::{
                 extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
                 state::Mint as MintState,
             };
             fn kinds(data: &[u8]) { let _ = StateWithExtensions::<MintState>::unpack(data); }",
        ),
        ("associated items of allowed types", "use anchor_spl::token::Token; fn f() { let id = Token::id(); let again = anchor_spl::token::ID; }"),
        ("an unrelated local function with a suspicious name", "fn transfer() {} fn f() { transfer(); }"),
        ("banned names in comments and strings", "// anchor_spl::token::transfer\n fn f() { msg!(\"transfer_checked burn invoke_signed\"); }"),
        ("renamed allowed types", "use anchor_spl::token_interface::{Mint as M, TokenAccount as TA}; type X = M; type Y = TA;"),
    ];
    for (label, source) in clean {
        assert_clean(label, Role::Program, source);
    }
}

#[test]
fn only_the_top_level_payout_rs_is_exempt() {
    assert_eq!(Role::of(Path::new("payout.rs")), Role::Payout);
    assert_eq!(Role::of(Path::new("instructions/payout.rs")), Role::Program);
    assert_eq!(Role::of(Path::new("payout/mod.rs")), Role::Program);
    assert_eq!(Role::of(Path::new("accounting.rs")), Role::Accounting);
    assert_eq!(
        Role::of(Path::new("instructions/accounting.rs")),
        Role::Program
    );
}

#[test]
fn payout_rs_has_a_fixed_public_surface_and_pay_out_takes_only_a_debit() {
    let ok = "pub fn pay_out(a: &A, escrow: &mut E, debit: Debit) -> Result<()> { Ok(()) }
              pub fn pay_in(f: &F, amount: u64) -> Result<()> { Ok(()) }
              pub fn close_escrow(a: &A) -> Result<()> { Ok(()) }
              fn helper(amount: u64) {}";
    assert_clean("the expected surface", Role::Payout, ok);
    for (label, source) in [
        ("a new public function", "pub fn pay_everyone(a: &A) {}"),
        (
            "a re-export",
            "pub use anchor_spl::token_interface::transfer_checked;",
        ),
        (
            "pay_out with a raw amount",
            "pub fn pay_out(a: &A, amount: u64) {}",
        ),
        (
            "pay_out with an amount next to the debit",
            "pub fn pay_out(a: &A, amount: u64, debit: Debit) {}",
        ),
        (
            "pay_out with a reference to a debit",
            "pub fn pay_out(a: &A, debit: &Debit) {}",
        ),
        ("pay_out without a debit", "pub fn pay_out(a: &A) {}"),
    ] {
        assert!(
            !run(Role::Payout, source).is_empty(),
            "{label} was not flagged"
        );
    }
}

#[test]
fn debit_cannot_be_given_a_way_to_be_copied_forged_or_deserialized() {
    let accounting = |body: &str| run(Role::Accounting, body);
    let good = "#[derive(Debug)] #[must_use = \"pay it\"] pub struct Debit { amount: u64 }
                impl Debit {
                    fn new(amount: u64) -> Self { Self { amount } }
                    pub fn amount(&self) -> u64 { self.amount }
                    pub(crate) fn into_amount(self) -> u64 { self.amount }
                }
                impl Ledger { pub fn pay(&mut self, a: u64) -> Result<Debit> { Ok(Debit::new(a)) } }";
    assert!(accounting(good).is_empty(), "{:?}", accounting(good));
    for (label, source) in [
        ("derive Clone", "#[derive(Debug, Clone)] #[must_use] pub struct Debit { amount: u64 }"),
        ("derive Copy", "#[derive(Clone, Copy)] #[must_use] pub struct Debit { amount: u64 }"),
        ("derive Default", "#[derive(Default)] #[must_use] pub struct Debit { amount: u64 }"),
        ("derive Anchor deserialization", "#[derive(AnchorDeserialize)] #[must_use] pub struct Debit { amount: u64 }"),
        ("public field", "#[must_use] pub struct Debit { pub amount: u64 }"),
        ("not must_use", "pub struct Debit { amount: u64 }"),
        ("impl Clone", "#[must_use] pub struct Debit { amount: u64 } impl Clone for Debit { fn clone(&self) -> Self { Debit { amount: self.amount } } }"),
        ("impl From<u64>", "#[must_use] pub struct Debit { amount: u64 } impl From<u64> for Debit { fn from(amount: u64) -> Self { Self { amount } } }"),
        ("public constructor", "#[must_use] pub struct Debit { amount: u64 } impl Debit { pub fn new(amount: u64) -> Self { Self { amount } } }"),
        ("crate-visible constructor", "#[must_use] pub struct Debit { amount: u64 } impl Debit { pub(crate) fn new(amount: u64) -> Self { Self { amount } } }"),
        ("literal outside Ledger", "#[must_use] pub struct Debit { amount: u64 } pub fn forge() -> Debit { Debit { amount: 5 } }"),
        ("constructor call outside Ledger", "#[must_use] pub struct Debit { amount: u64 } pub fn forge() -> Debit { Debit::new(5) }"),
    ] {
        assert!(!accounting(source).is_empty(), "{label} was not flagged");
    }
}

#[test]
fn a_debit_literal_in_another_file_is_flagged() {
    assert_flagged("literal", "fn forge() -> Debit { Debit { amount: 5 } }");
    assert_flagged("constructor", "fn forge() -> Debit { Debit::new(5) }");
}

#[test]
fn the_manifest_refuses_crates_that_call_the_token_program_even_renamed() {
    let check = |toml: &str| check_manifest(Path::new("Cargo.toml"), toml).unwrap();
    assert!(check("[dependencies]\nanchor-lang = \"1\"\nanchor-spl = \"1\"\n[dev-dependencies]\nspl-token = \"8\"\n").is_empty());
    for toml in [
        "[dependencies]\nspl-token = \"8\"\n",
        "[dependencies]\nspl-token-2022 = { version = \"9\", features = [\"no-entrypoint\"] }\n",
        "[dependencies]\ntokens = { package = \"spl-token\", version = \"8\" }\n",
        "[dependencies]\npinocchio-token = \"0.4\"\n",
        "[dependencies]\nsolana-invoke = \"0.5\"\n",
        "[target.'cfg(target_os = \"solana\")'.dependencies]\nspl-token-interface = \"2\"\n",
        "[build-dependencies]\npinocchio = \"0.9\"\n",
    ] {
        assert_eq!(check(toml).len(), 1, "{toml}");
    }
}

fn program_dir(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"p\"\nversion = \"0.1.0\"\n[dependencies]\nanchor-lang = \"1\"\n",
    )
    .unwrap();
    for (path, content) in files {
        let full = dir.path().join("src").join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }
    dir
}

const PAYOUT: &str = "use anchor_spl::token_interface::transfer_checked;\npub fn pay_out(d: Debit) { transfer_checked(c, 1, 6).unwrap(); }\n";

#[test]
fn a_planted_transfer_in_another_file_fails_the_whole_program_and_payout_rs_alone_does_not() {
    let clean = program_dir(&[("payout.rs", PAYOUT), ("lib.rs", "pub mod payout;\n")]);
    assert!(check_program(clean.path()).unwrap().is_empty());

    let planted = program_dir(&[
        ("payout.rs", PAYOUT),
        ("lib.rs", "pub mod payout;\n"),
        ("instructions/register_device.rs", "pub fn f(c: C) {\n    anchor_spl::token_interface::transfer_checked(c, 1, 6).unwrap();\n}\n"),
    ]);
    let findings = check_program(planted.path()).unwrap();
    assert_eq!(findings.len(), 1, "{findings:?}");
    assert!(
        findings[0]
            .file
            .ends_with("instructions/register_device.rs")
            && findings[0].line == 2
    );
}

#[test]
fn the_binary_exits_1_on_a_finding_0_when_clean_and_2_when_it_cannot_read_the_code() {
    let bin = env!("CARGO_BIN_EXE_check-payouts");
    let clean = program_dir(&[("payout.rs", PAYOUT)]);
    assert_eq!(
        Command::new(bin).arg(clean.path()).status().unwrap().code(),
        Some(0)
    );

    let planted = program_dir(&[
        ("payout.rs", PAYOUT),
        ("a.rs", "fn f() { anchor_spl::token::burn(c, 1).unwrap(); }"),
    ]);
    let out = Command::new(bin).arg(planted.path()).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("a.rs:1:"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let broken = program_dir(&[("a.rs", "fn f( {")]);
    assert_eq!(
        Command::new(bin)
            .arg(broken.path())
            .status()
            .unwrap()
            .code(),
        Some(2)
    );
    assert_eq!(Command::new(bin).status().unwrap().code(), Some(2));
}

const BANNED: &[(&str, &str)] = &[
    ("anchor_spl::token", "transfer"),
    ("anchor_spl::token", "burn"),
    ("anchor_spl::token", "close_account"),
    ("anchor_spl::token", "mint_to"),
    ("anchor_spl::token", "set_authority"),
    ("anchor_spl::token", "approve"),
    ("anchor_spl::token_interface", "transfer_checked"),
    ("anchor_spl::token_interface", "burn_checked"),
    ("anchor_spl::token_interface", "close_account"),
    ("anchor_spl::token_interface", "freeze_account"),
    ("anchor_spl::token_2022", "transfer_checked"),
    ("anchor_spl::token_2022", "burn"),
    ("anchor_lang::solana_program::program", "invoke"),
    ("anchor_lang::solana_program::program", "invoke_signed"),
    (
        "anchor_lang::solana_program::program",
        "invoke_signed_unchecked",
    ),
];

fn alias() -> impl Strategy<Value = String> {
    "[a-z][a-z0-9_]{0,8}".prop_map(|s| format!("a_{s}"))
}

proptest! {
    #[test]
    fn no_spelling_of_a_banned_call_escapes(index in 0..BANNED.len(), name in alias(), group in any::<bool>()) {
        let (module, function) = BANNED[index];
        let (parent, leaf) = module.rsplit_once("::").unwrap();
        let forms = [
            format!("use {module}::{function} as {name}; fn t() {{ {name}(x); }}"),
            format!("use {module} as {name}; fn t() {{ {name}::{function}(x); }}"),
            format!("use {parent}::{{{leaf}::{{self as {name}}}}}; fn t() {{ {name}::{function}(x); }}"),
            format!("use {parent}::{{{leaf} as {name}}}; fn t() {{ {name}::{function}(x); }}"),
            format!("use {module}::{{{function} as {name}}}; fn t() {{ let f = {name}; }}"),
            format!("fn t() {{ {module}::{function}(x); }}"),
            format!("fn t() {{ require!({module}::{function}(x).is_ok(), E::A); }}"),
            format!("mod {name} {{ pub fn t() {{ let f = || {module}::{function}(x); }} }}"),
        ];
        let form = if group { &forms[2] } else { &forms[index % forms.len()] };
        prop_assert!(!run(Role::Program, form).is_empty(), "not flagged: {form}");
        prop_assert!(run(Role::Payout, form).is_empty(), "flagged in payout.rs: {form}");
    }

    #[test]
    fn renaming_an_allowed_type_never_causes_a_finding(name in alias(), which in 0..3usize) {
        let ty = ["Mint", "TokenAccount", "TokenInterface"][which];
        let source = format!("use anchor_spl::token_interface::{{{ty} as {name}}}; type X = {name};");
        prop_assert!(run(Role::Program, &source).is_empty(), "{source}");
    }
}
