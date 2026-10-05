//! Lint for the escrow payout rule: outside `payout.rs` no code moves tokens out of an escrow,
//! closes a token account or makes a raw cross-program invocation, however the call is spelled
//! (renamed or aliased imports, fully qualified paths, nested `use` groups, calls inside macro
//! arguments and `#[account(...)]` constraints, method-style `invoke`).
//!
//! Policy: a path that resolves into `anchor_spl` is allowed only if it names one of a few types;
//! a path into the `spl_token*`/`pinocchio*` crates is allowed only for their read-only `state` and
//! `extension` modules; any item named `invoke*` is forbidden; so is `unsafe`, `extern` blocks,
//! `macro_rules!`, `include!` and `#[path]`.

use proc_macro2::{Spacing, TokenStream, TokenTree};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use syn::{
    spanned::Spanned,
    visit::{self, Visit},
    Attribute, Expr, ExprMethodCall, ExprStruct, ExprUnsafe, ImplItem, ImplItemFn, Item,
    ItemExternCrate, ItemFn, ItemForeignMod, ItemImpl, ItemMacro, ItemStruct, ItemTrait, ItemUse,
    Macro, Meta, Type, UseTree, Visibility,
};

const TOKEN_CRATES: &[&str] = &[
    "spl_token",
    "spl_token_2022",
    "spl_token_interface",
    "spl_token_2022_interface",
    "spl_associated_token_account",
    "spl_associated_token_account_interface",
    "pinocchio_token",
    "pinocchio_token_2022",
    "pinocchio_associated_token_account",
];
/// Whole crates whose use is a raw CPI or system access path.
const BANNED_CRATES: &[&str] = &["pinocchio", "solana_cpi", "solana_invoke"];
const READ_ONLY_MODULES: &[&str] = &[
    "state",
    "extension",
    "error",
    "ID",
    "id",
    "check_id",
    "check_program_account",
    "native_mint",
];
const FORBIDDEN_SEGMENTS: &[&str] = &["instruction", "instructions", "onchain", "processor", "cpi"];
const ANCHOR_SPL_MODULES: &[&str] = &[
    "associated_token",
    "dex",
    "memo",
    "metadata",
    "mint",
    "stake",
    "token",
    "token_2022",
    "token_2022_extensions",
    "token_interface",
];
const ANCHOR_SPL_ALLOWED: &[&str] = &[
    "Mint",
    "TokenAccount",
    "TokenInterface",
    "Token",
    "Token2022",
    "AssociatedToken",
    "ID",
    "id",
];
const PAYOUT_PUBLIC_FUNCTIONS: &[&str] = &["pay_out", "pay_in", "close_escrow", "burn_out"];
const DEBIT_FORBIDDEN_DERIVES: &[&str] = &[
    "Clone",
    "Copy",
    "Default",
    "AnchorDeserialize",
    "AnchorSerialize",
    "BorshDeserialize",
    "BorshSerialize",
    "Deserialize",
    "Serialize",
];
const DEBIT_FORBIDDEN_IMPLS: &[&str] = &[
    "Clone",
    "Copy",
    "Default",
    "From",
    "TryFrom",
    "FromStr",
    "Deserialize",
    "AnchorDeserialize",
];
const BANNED_MANIFEST_CRATES: &[&str] = &[
    "spl-token",
    "spl-token-2022",
    "spl-token-interface",
    "spl-token-2022-interface",
    "spl-associated-token-account",
    "spl-associated-token-account-interface",
    "pinocchio",
    "pinocchio-token",
    "pinocchio-token-2022",
    "solana-cpi",
    "solana-invoke",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub file: PathBuf,
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Every file except the two below.
    Program,
    /// `src/payout.rs`: the only file allowed to call the token program.
    Payout,
    /// `src/accounting.rs`: defines `Debit`.
    Accounting,
    /// `src/filing.rs`: the one file that may name `burn_out`.
    Filing,
}

impl Role {
    pub fn of(relative_to_src: &Path) -> Self {
        match relative_to_src.to_str() {
            Some("payout.rs") => Self::Payout,
            Some("accounting.rs") => Self::Accounting,
            Some("filing.rs") => Self::Filing,
            _ => Self::Program,
        }
    }
}

/// Checks `<program_dir>/Cargo.toml` and every `.rs` file under `<program_dir>/src`.
pub fn check_program(program_dir: &Path) -> Result<Vec<Finding>, String> {
    let manifest = program_dir.join("Cargo.toml");
    let text = fs::read_to_string(&manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
    let mut findings = check_manifest(&manifest, &text)?;
    let src = program_dir.join("src");
    let mut files = Vec::new();
    collect(&src, &mut files).map_err(|e| format!("{}: {e}", src.display()))?;
    files.sort();
    for file in files {
        let source = fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let relative = file.strip_prefix(&src).unwrap_or(&file);
        findings.extend(check_source(&file, &source, Role::of(relative))?);
    }
    Ok(findings)
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

/// Direct dependencies that exist to call the token program are refused, also under a rename.
pub fn check_manifest(path: &Path, text: &str) -> Result<Vec<Finding>, String> {
    let value: toml::Table = text
        .parse()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let mut tables: Vec<&toml::Table> = Vec::new();
    for key in ["dependencies", "build-dependencies"] {
        if let Some(t) = value.get(key).and_then(|v| v.as_table()) {
            tables.push(t);
        }
    }
    if let Some(targets) = value.get("target").and_then(|v| v.as_table()) {
        for target in targets.values() {
            for key in ["dependencies", "build-dependencies"] {
                if let Some(t) = target.get(key).and_then(|v| v.as_table()) {
                    tables.push(t);
                }
            }
        }
    }
    let mut findings = Vec::new();
    for table in tables {
        for (name, spec) in table {
            let package = spec.get("package").and_then(|p| p.as_str()).unwrap_or(name);
            if BANNED_MANIFEST_CRATES.contains(&package) {
                findings.push(Finding {
                    file: path.to_owned(),
                    line: 0,
                    message: format!("dependency `{name}` ({package}) calls the token program; only payout.rs may, through anchor-spl"),
                });
            }
        }
    }
    Ok(findings)
}

pub fn check_source(file: &Path, source: &str, role: Role) -> Result<Vec<Finding>, String> {
    let ast = syn::parse_file(source).map_err(|e| format!("{}: {e}", file.display()))?;
    let mut scope = Scope::default();
    scope.collect(&ast.items);
    let mut checker = Checker {
        file,
        role,
        scope,
        findings: Vec::new(),
        in_ledger_impl: false,
    };
    checker.visit_file(&ast);
    if role == Role::Payout {
        checker.check_payout_items(&ast.items);
    }
    if !matches!(role, Role::Payout | Role::Filing) {
        let tokens: TokenStream = source
            .parse()
            .map_err(|e| format!("{}: {e}", file.display()))?;
        let mut lines = Vec::new();
        mentions(tokens, "burn_out", &mut lines);
        for line in lines {
            checker.flag(line, "`burn_out` is named only by payout.rs, which defines it, and filing.rs, its one call: an alias, a path, a re-export or a function value anywhere else is a burn the call-site rule cannot see".into());
        }
    }
    Ok(checker.findings)
}

/// Every line where `name` appears as an identifier in `stream`, groups and macro arguments
/// included; comments and string literals are not identifiers.
fn mentions(stream: TokenStream, name: &str, lines: &mut Vec<usize>) {
    for tree in stream {
        match tree {
            TokenTree::Ident(ident) if ident.to_string().trim_start_matches("r#") == name => {
                lines.push(ident.span().start().line);
            }
            TokenTree::Group(group) => mentions(group.stream(), name, lines),
            _ => {}
        }
    }
}

#[derive(Default)]
struct Scope {
    aliases: HashMap<String, Vec<String>>,
    globs: Vec<Vec<String>>,
}

impl Scope {
    fn collect(&mut self, items: &[Item]) {
        struct Collector<'a>(&'a mut Scope);
        impl<'ast> Visit<'ast> for Collector<'_> {
            fn visit_item_use(&mut self, item: &'ast ItemUse) {
                let mut entries = Vec::new();
                flatten(&item.tree, &mut Vec::new(), &mut entries);
                for entry in entries {
                    match entry {
                        UseEntry::Name(name, path) => {
                            self.0.aliases.insert(name, path);
                        }
                        UseEntry::Glob(path) => self.0.globs.push(path),
                    }
                }
            }
            fn visit_item_extern_crate(&mut self, item: &'ast ItemExternCrate) {
                if let Some((_, alias)) = &item.rename {
                    self.0
                        .aliases
                        .insert(alias.to_string(), vec![item.ident.to_string()]);
                }
            }
        }
        let mut collector = Collector(self);
        for item in items {
            collector.visit_item(item);
        }
    }

    /// Replaces the first segment while it is an alias (`use a::b as c`, `use a::{self as c}`, `extern crate a as c`).
    fn resolve(&self, segments: &[String]) -> Vec<String> {
        let mut path = segments.to_vec();
        for _ in 0..8 {
            let Some(first) = path.first() else { break };
            if matches!(first.as_str(), "crate" | "self" | "super" | "Self") {
                break;
            }
            match self.aliases.get(first) {
                Some(target) if target.first() != Some(first) || target.len() > 1 => {
                    let mut next = target.clone();
                    next.extend_from_slice(&path[1..]);
                    if next == path {
                        break;
                    }
                    path = next;
                }
                _ => break,
            }
        }
        path
    }
}

enum UseEntry {
    Name(String, Vec<String>),
    Glob(Vec<String>),
}

fn flatten(tree: &UseTree, prefix: &mut Vec<String>, out: &mut Vec<UseEntry>) {
    match tree {
        UseTree::Path(p) => {
            prefix.push(p.ident.to_string());
            flatten(&p.tree, prefix, out);
            prefix.pop();
        }
        UseTree::Name(n) => {
            let ident = n.ident.to_string();
            if ident == "self" {
                if let Some(last) = prefix.last() {
                    out.push(UseEntry::Name(last.clone(), prefix.clone()));
                }
            } else {
                let mut path = prefix.clone();
                path.push(ident.clone());
                out.push(UseEntry::Name(ident, path));
            }
        }
        UseTree::Rename(r) => {
            let ident = r.ident.to_string();
            let mut path = prefix.clone();
            if ident != "self" {
                path.push(ident);
            }
            out.push(UseEntry::Name(r.rename.to_string(), path));
        }
        UseTree::Glob(_) => out.push(UseEntry::Glob(prefix.clone())),
        UseTree::Group(g) => {
            for item in &g.items {
                flatten(item, prefix, out);
            }
        }
    }
}

struct Checker<'a> {
    file: &'a Path,
    role: Role,
    scope: Scope,
    findings: Vec<Finding>,
    in_ledger_impl: bool,
}

impl Checker<'_> {
    fn flag(&mut self, line: usize, message: String) {
        self.findings.push(Finding {
            file: self.file.to_owned(),
            line,
            message,
        });
    }

    fn exempt(&self) -> bool {
        self.role == Role::Payout
    }

    /// The rules for one path as written; `line` is where it appears.
    fn check_path(&mut self, written: &[String], line: usize) {
        if self.exempt() || written.is_empty() {
            return;
        }
        let resolved = self.scope.resolve(written);
        let shown = resolved.join("::");
        if let Some(reason) = violation(&resolved) {
            self.flag(line, format!("`{shown}`: {reason}"));
        }
    }

    fn check_glob(&mut self, target: &[String], line: usize) {
        if self.exempt() {
            return;
        }
        let resolved = self.scope.resolve(target);
        let root = resolved.first().map(String::as_str).unwrap_or("");
        let second = resolved.get(1).map(String::as_str).unwrap_or("");
        let bad = TOKEN_CRATES.contains(&root)
            || BANNED_CRATES.contains(&root)
            || root == "anchor_spl"
            || (matches!(root, "solana_program" | "anchor_lang")
                && resolved.iter().any(|s| s == "program"))
            || (root == "anchor_lang" && second == "solana_program" && resolved.len() == 2);
        if bad {
            self.flag(
                line,
                format!(
                    "glob import `{}::*` may bring in a token or invoke function; import by name",
                    resolved.join("::")
                ),
            );
        }
    }

    /// Tokens of macro invocations and attributes are not parsed by `syn`: scan them for path-shaped sequences.
    fn scan_tokens(&mut self, stream: TokenStream, in_attribute: bool) {
        let tokens: Vec<TokenTree> = stream.into_iter().collect();
        let is_colon =
            |t: Option<&TokenTree>| matches!(t, Some(TokenTree::Punct(p)) if p.as_char() == ':');
        let mut i = 0;
        while i < tokens.len() {
            match &tokens[i] {
                TokenTree::Group(g) => {
                    self.scan_tokens(g.stream(), in_attribute);
                    i += 1;
                }
                TokenTree::Ident(id) => {
                    let line = id.span().start().line;
                    let start = i;
                    let mut segments = vec![id.to_string()];
                    i += 1;
                    while is_colon(tokens.get(i)) && is_colon(tokens.get(i + 1)) {
                        let Some(TokenTree::Ident(next)) = tokens.get(i + 2) else {
                            break;
                        };
                        segments.push(next.to_string());
                        i += 3;
                    }
                    let method = start > 0
                        && matches!(&tokens[start - 1], TokenTree::Punct(p) if p.as_char() == '.');
                    let constraint_key = in_attribute
                        && matches!(tokens.get(i), Some(TokenTree::Punct(p)) if p.as_char() == '=' && p.spacing() == Spacing::Alone);
                    if method {
                        if !self.exempt() && is_invoke(&segments[0]) {
                            self.flag(
                                line,
                                format!(
                                    "method call `.{}` is a raw cross-program invocation",
                                    segments[0]
                                ),
                            );
                        }
                    } else if !constraint_key {
                        self.check_path(&segments, line);
                    }
                }
                _ => i += 1,
            }
        }
    }

    fn check_payout_items(&mut self, items: &[Item]) {
        for item in items {
            match item {
                Item::Use(u) if !matches!(u.vis, Visibility::Inherited) => {
                    self.flag(
                        u.span().start().line,
                        "payout.rs must not re-export anything".into(),
                    );
                }
                Item::Fn(f) => {
                    let name = f.sig.ident.to_string();
                    // Private and `pub(crate)` functions too: a helper that takes a raw amount would
                    // move tokens without a `Debit`.
                    if !PAYOUT_PUBLIC_FUNCTIONS.contains(&name.as_str()) {
                        self.flag(f.span().start().line, format!("function `{name}` in payout.rs, of any visibility: payout.rs holds exactly {PAYOUT_PUBLIC_FUNCTIONS:?}; review it and add it to the lint"));
                    }
                    if name == "pay_out" || name == "burn_out" {
                        self.check_pay_out(f);
                    }
                }
                Item::Impl(i) => {
                    self.flag(
                        i.span().start().line,
                        "payout.rs has no impl blocks: a method could move tokens without a `Debit`".into(),
                    );
                }
                _ => {}
            }
        }
    }

    fn check_pay_out(&mut self, f: &ItemFn) {
        let line = f.span().start().line;
        let params: Vec<&syn::PatType> = f
            .sig
            .inputs
            .iter()
            .filter_map(|a| {
                if let syn::FnArg::Typed(t) = a {
                    Some(t)
                } else {
                    None
                }
            })
            .collect();
        let last_is_debit = params.last().is_some_and(|p| matches!(&*p.ty, Type::Path(t) if t.path.segments.last().is_some_and(|s| s.ident == "Debit")));
        if !last_is_debit {
            self.flag(
                line,
                "pay_out must take its amount as a `Debit` by value, as its last parameter".into(),
            );
        }
        for p in &params {
            let primitive = matches!(&*p.ty, Type::Path(t) if t.path.segments.len() == 1
                && matches!(t.path.segments[0].ident.to_string().as_str(), "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128" | "isize"));
            if primitive {
                self.flag(line, "pay_out must not take an integer parameter: the amount comes only from the `Debit`".into());
            }
        }
    }

    fn check_debit_struct(&mut self, item: &ItemStruct) {
        let line = item.span().start().line;
        if item
            .fields
            .iter()
            .any(|f| !matches!(f.vis, Visibility::Inherited))
        {
            self.flag(line, "Debit must have private fields".into());
        }
        if !item.attrs.iter().any(|a| a.path().is_ident("must_use")) {
            self.flag(line, "Debit must be #[must_use]".into());
        }
        for attr in &item.attrs {
            if attr.path().is_ident("derive") {
                let mut names = Vec::new();
                let _ = attr.parse_nested_meta(|meta| {
                    if let Some(last) = meta.path.segments.last() {
                        names.push(last.ident.to_string());
                    }
                    Ok(())
                });
                for name in names {
                    if DEBIT_FORBIDDEN_DERIVES.contains(&name.as_str()) {
                        self.flag(line, format!("Debit must not derive {name}"));
                    }
                }
            }
        }
    }
}

fn is_invoke(name: &str) -> bool {
    name.starts_with("invoke") || name.starts_with("slice_invoke") || name.starts_with("sol_invoke")
}

/// Why a resolved path is forbidden outside `payout.rs`, if it is.
fn violation(path: &[String]) -> Option<&'static str> {
    let leaf = path.last()?;
    if is_invoke(leaf) {
        return Some("raw cross-program invocation");
    }
    let root = path[0].as_str();
    if BANNED_CRATES.contains(&root) {
        return Some("this crate performs raw invocations");
    }
    if TOKEN_CRATES.contains(&root) {
        return token_crate_violation(path);
    }
    if root == "anchor_spl" {
        let rest = &path[1..];
        let module = rest.first()?;
        if !ANCHOR_SPL_MODULES.contains(&module.as_str()) {
            return Some("unknown anchor_spl module");
        }
        return match rest.get(1).map(String::as_str) {
            None => None,
            Some(next) if TOKEN_CRATES.contains(&next) => token_crate_violation(&rest[1..]),
            Some(next) if ANCHOR_SPL_ALLOWED.contains(&next) => None,
            Some(_) => Some("token program function or CPI struct; only payout.rs may use it"),
        };
    }
    None
}

fn token_crate_violation(path: &[String]) -> Option<&'static str> {
    if path.len() < 2 {
        return None;
    }
    if path
        .iter()
        .any(|s| FORBIDDEN_SEGMENTS.contains(&s.as_str()))
    {
        return Some("instruction builder or CPI helper of the token program");
    }
    if READ_ONLY_MODULES.contains(&path[1].as_str()) {
        None
    } else {
        Some("only the read-only `state` and `extension` modules of the token crates may be used outside payout.rs")
    }
}

impl<'ast> Visit<'ast> for Checker<'_> {
    fn visit_item_use(&mut self, item: &'ast ItemUse) {
        let line = item.span().start().line;
        let mut entries = Vec::new();
        flatten(&item.tree, &mut Vec::new(), &mut entries);
        for entry in entries {
            match entry {
                UseEntry::Name(_, path) => self.check_path(&path, line),
                UseEntry::Glob(path) => self.check_glob(&path, line),
            }
        }
    }

    fn visit_path(&mut self, path: &'ast syn::Path) {
        let segments: Vec<String> = path.segments.iter().map(|s| s.ident.to_string()).collect();
        self.check_path(&segments, path.span().start().line);
        visit::visit_path(self, path);
    }

    fn visit_expr_method_call(&mut self, call: &'ast ExprMethodCall) {
        if !self.exempt() && is_invoke(&call.method.to_string()) {
            self.flag(
                call.method.span().start().line,
                format!(
                    "method call `.{}` is a raw cross-program invocation",
                    call.method
                ),
            );
        }
        visit::visit_expr_method_call(self, call);
    }

    fn visit_macro(&mut self, mac: &'ast Macro) {
        if !self.exempt() {
            if let Some(leaf) = mac.path.segments.last() {
                let name = leaf.ident.to_string();
                if matches!(
                    name.as_str(),
                    "include" | "asm" | "global_asm" | "naked_asm"
                ) {
                    self.flag(
                        leaf.ident.span().start().line,
                        format!("`{name}!` can hide code from this lint"),
                    );
                }
            }
            self.scan_tokens(mac.tokens.clone(), false);
        }
        visit::visit_macro(self, mac);
    }

    fn visit_item_macro(&mut self, item: &'ast ItemMacro) {
        if !self.exempt() && item.mac.path.is_ident("macro_rules") {
            self.flag(
                item.span().start().line,
                "macro_rules! can hide calls from this lint".into(),
            );
        }
        visit::visit_item_macro(self, item);
    }

    fn visit_attribute(&mut self, attr: &'ast Attribute) {
        if !self.exempt() {
            if attr.path().is_ident("path") {
                self.flag(
                    attr.span().start().line,
                    "#[path] can pull in a file this lint does not read".into(),
                );
            }
            if !attr.path().is_ident("doc") {
                if let Meta::List(list) = &attr.meta {
                    self.scan_tokens(list.tokens.clone(), true);
                }
            }
        }
        visit::visit_attribute(self, attr);
    }

    fn visit_expr_unsafe(&mut self, e: &'ast ExprUnsafe) {
        if !self.exempt() {
            self.flag(e.span().start().line, "unsafe block".into());
        }
        visit::visit_expr_unsafe(self, e);
    }

    fn visit_item_fn(&mut self, f: &'ast ItemFn) {
        if !self.exempt() && f.sig.unsafety.is_some() {
            self.flag(f.span().start().line, "unsafe fn".into());
        }
        visit::visit_item_fn(self, f);
    }

    fn visit_item_trait(&mut self, t: &'ast ItemTrait) {
        if !self.exempt() && t.unsafety.is_some() {
            self.flag(t.span().start().line, "unsafe trait".into());
        }
        visit::visit_item_trait(self, t);
    }

    fn visit_item_foreign_mod(&mut self, m: &'ast ItemForeignMod) {
        if !self.exempt() {
            self.flag(m.span().start().line, "extern block (raw syscalls)".into());
        }
        visit::visit_item_foreign_mod(self, m);
    }

    fn visit_item_struct(&mut self, item: &'ast ItemStruct) {
        if self.role == Role::Accounting && item.ident == "Debit" {
            self.check_debit_struct(item);
        }
        visit::visit_item_struct(self, item);
    }

    fn visit_item_impl(&mut self, item: &'ast ItemImpl) {
        if !self.exempt() && item.unsafety.is_some() {
            self.flag(item.span().start().line, "unsafe impl".into());
        }
        let self_name = match &*item.self_ty {
            Type::Path(t) => t.path.segments.last().map(|s| s.ident.to_string()),
            _ => None,
        };
        let inherent = item.trait_.is_none();
        if self.role == Role::Accounting && self_name.as_deref() == Some("Debit") {
            if let Some((_, trait_path, _)) = &item.trait_ {
                let trait_name = trait_path
                    .segments
                    .last()
                    .map(|s| s.ident.to_string())
                    .unwrap_or_default();
                if DEBIT_FORBIDDEN_IMPLS.contains(&trait_name.as_str()) {
                    self.flag(
                        item.span().start().line,
                        format!("Debit must not implement {trait_name}"),
                    );
                }
            }
            if inherent {
                for member in &item.items {
                    if let ImplItem::Fn(f) = member {
                        self.check_debit_method(f);
                    }
                }
            }
        }
        let previous = self.in_ledger_impl;
        self.in_ledger_impl = inherent && self_name.as_deref() == Some("Ledger");
        visit::visit_item_impl(self, item);
        self.in_ledger_impl = previous;
    }

    fn visit_expr_struct(&mut self, e: &'ast ExprStruct) {
        if self.role != Role::Payout
            && e.path.segments.last().is_some_and(|s| s.ident == "Debit")
            && !self.in_ledger_impl
        {
            self.flag(
                e.span().start().line,
                "Debit is built only inside `impl Ledger` methods".into(),
            );
        }
        visit::visit_expr_struct(self, e);
    }

    fn visit_expr(&mut self, e: &'ast Expr) {
        if let Expr::Call(call) = e {
            if let Expr::Path(p) = &*call.func {
                let segs: Vec<String> = p
                    .path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect();
                if segs.len() >= 2
                    && segs[segs.len() - 2] == "Debit"
                    && !self.in_ledger_impl
                    && self.role != Role::Payout
                {
                    // `Debit::amount(&d)` and similar accessors take an existing value; only constructors matter.
                    let ctor = segs.last().is_some_and(|n| n != "amount");
                    if ctor {
                        self.flag(
                            e.span().start().line,
                            format!(
                                "`{}`: Debit is built only inside `impl Ledger` methods",
                                segs.join("::")
                            ),
                        );
                    }
                }
            }
        }
        visit::visit_expr(self, e);
    }
}

impl Checker<'_> {
    fn check_debit_method(&mut self, f: &ImplItemFn) {
        let line = f.span().start().line;
        let receiver = f.sig.receiver();
        match &f.vis {
            Visibility::Public(_) => {
                if !receiver.is_some_and(|r| r.reference.is_some()) {
                    self.flag(
                        line,
                        format!(
                            "public `{}` on Debit must take `&self`: no public constructor",
                            f.sig.ident
                        ),
                    );
                }
            }
            Visibility::Restricted(_) => {
                if !receiver.is_some_and(|r| r.reference.is_none()) {
                    self.flag(
                        line,
                        format!(
                            "restricted `{}` on Debit must take `self` by value",
                            f.sig.ident
                        ),
                    );
                }
            }
            Visibility::Inherited => {}
        }
    }
}
