//! Generates `prover/testdata/vectors.json`: chains signed with software P-256 keys through the
//! protocol crate, and the invalid cases, each of which breaks one thing of one message.
use std::{fs, path::PathBuf};

use buckspay_protocol::{
    chain::{self, Holding, Output},
    cluster::DEVNET_GENESIS_HASH,
    flags,
    hash::{self, purpose},
    lock::EXPIRY_STEP,
    message::issue_slot,
    Caveats, Issue, Outputs, Owner, ScopeKind, Spend, MAX_DEPTH, NO_LOCK,
};
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::{ops::Reduce, PrimeField},
    FieldBytes, PublicKey, Scalar,
};
use serde::Serialize;

const PROGRAM: [u8; 32] = [0xb0; 32];
const MINT: [u8; 32] = [3; 32];
const EXPIRY: u32 = 1_900_000_000;
const LOCK_SEQ: u32 = 7;
const ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];
const FIELD_PRIME: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

#[cfg(test)]
const REQUIRED_REASONS: [&str; 19] = [
    "wrong_signer",
    "other_issuer_key",
    "high_s",
    "altered_s_in",
    "altered_e",
    "amount0_not_below_input",
    "hops_not_decreasing",
    "expiry_extended",
    "merchant_scope",
    "no_lock_without_delegation",
    "last_pays_a_device",
    "altered_payment_amount",
    "change_to_other_key",
    "key_x_not_below_p",
    "r_zero",
    "s_zero",
    "r_not_below_n",
    "s_not_below_n",
    "recovered_point_at_infinity",
];

#[derive(Clone, PartialEq, Serialize)]
struct SignedJson {
    kind: u8,
    body: String,
    sig_r: String,
    sig_s: String,
    key: String,
}

#[derive(Clone, PartialEq, Serialize)]
struct OpeningJson {
    owner: String,
    amount: u64,
    caveats: String,
    salt: String,
    index: u8,
}

#[derive(Clone, PartialEq, Serialize)]
struct Override {
    index: usize,
    delta: String,
}

#[derive(Serialize)]
struct ValidChain {
    name: String,
    messages: Vec<SignedJson>,
    openings: Vec<OpeningJson>,
    message_ids: Vec<String>,
    output_ids: Vec<[String; 2]>,
    public: Vec<[String; 10]>,
    #[cfg(test)]
    #[serde(skip)]
    domain: [u8; 32],
    #[cfg(test)]
    #[serde(skip)]
    slots: Vec<[u8; 32]>,
}

#[derive(Serialize)]
struct InvalidCase {
    name: String,
    reason: String,
    messages: Vec<SignedJson>,
    openings: Vec<OpeningJson>,
    bad: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_override: Option<Override>,
}

#[derive(Serialize)]
struct Vectors {
    domain: String,
    valid: Vec<ValidChain>,
    invalid: Vec<InvalidCase>,
}

#[derive(Clone)]
struct Key {
    signing: SigningKey,
    public: [u8; 33],
}

impl Key {
    fn new(seed: u8) -> Key {
        let signing = SigningKey::from_slice(&[seed; 32]).unwrap();
        let mut public = [0; 33];
        public.copy_from_slice(signing.verifying_key().to_sec1_point(true).as_bytes());
        Key { signing, public }
    }

    fn owner(&self) -> Owner {
        Owner::Device(self.public)
    }

    fn sign(&self, envelope: &[u8]) -> [u8; 64] {
        let signature: Signature = self.signing.sign(envelope);
        signature.normalize_s().to_bytes().into()
    }
}

fn keys() -> [Key; 4] {
    [Key::new(1), Key::new(2), Key::new(3), Key::new(4)]
}

fn account(byte: u8) -> Owner {
    Owner::Account([byte; 32])
}

fn caveats(
    expiry: u32,
    hops_left: u8,
    flags: u8,
    scope_kind: ScopeKind,
    scope: [u8; 20],
) -> Caveats {
    Caveats {
        expiry,
        hops_left,
        flags,
        scope_kind,
        scope,
    }
}

fn plain(expiry: u32, hops_left: u8) -> Caveats {
    caveats(expiry, hops_left, 0, ScopeKind::Any, [0; 20])
}

#[derive(Clone)]
enum Msg {
    Issue(Issue),
    Spend(Spend),
}

impl Msg {
    fn kind(&self) -> u8 {
        match self {
            Msg::Issue(_) => buckspay_protocol::kind::ISSUE,
            Msg::Spend(s) => match s.outputs {
                Outputs::One { .. } => buckspay_protocol::kind::SPEND1,
                Outputs::Two { .. } => buckspay_protocol::kind::SPEND2,
            },
        }
    }

    fn body(&self) -> Vec<u8> {
        match self {
            Msg::Issue(i) => i.body().to_vec(),
            Msg::Spend(s) => {
                let mut out = [0; 123];
                let len = s.body(&mut out);
                out[..len].to_vec()
            }
        }
    }
}

#[derive(Clone)]
struct Builder {
    domain: [u8; 32],
    msgs: Vec<Msg>,
    signed: Vec<SignedJson>,
    opens: Vec<OpeningJson>,
    holdings: Vec<Holding>,
    salts: Vec<[u8; 16]>,
    slots: Vec<[u8; 32]>,
}

fn sig_json(kind: u8, body: &[u8], sig: &[u8; 64], key: &[u8; 33]) -> SignedJson {
    SignedJson {
        kind,
        body: hex::encode(body),
        sig_r: hex::encode(&sig[..32]),
        sig_s: hex::encode(&sig[32..]),
        key: hex::encode(key),
    }
}

fn open_json(input: &Output, salt: [u8; 16], index: u8) -> OpeningJson {
    OpeningJson {
        owner: hex::encode(input.owner.encode()),
        amount: input.amount,
        caveats: hex::encode(input.caveats.encode()),
        salt: hex::encode(salt),
        index,
    }
}

fn empty_opening() -> OpeningJson {
    OpeningJson {
        owner: hex::encode([0u8; 33]),
        amount: 0,
        caveats: hex::encode([0u8; 27]),
        salt: hex::encode([0u8; 16]),
        index: 0,
    }
}

impl Builder {
    fn issue(signer: &Key, issue: Issue) -> Builder {
        let domain = domain();
        let (env, output) = chain::issue_signing(&domain, &issue).expect("valid issue");
        let sig = signer.sign(&env);
        let msg = Msg::Issue(issue);
        Builder {
            domain,
            signed: vec![sig_json(msg.kind(), &msg.body(), &sig, &signer.public)],
            opens: vec![empty_opening()],
            holdings: vec![Holding {
                first: output,
                second: None,
            }],
            salts: vec![issue.salt],
            slots: vec![issue.slot().unwrap()],
            msgs: vec![msg],
        }
    }

    fn input(&self, consume: u8) -> Output {
        let last = self.holdings.last().unwrap();
        if consume == 0 {
            last.first
        } else {
            last.second
                .expect("the previous message has a change output")
        }
    }

    fn spend(&mut self, signer: &Key, consume: u8, outputs: Outputs, lock_seq: u32, salt: u8) {
        let input = self.input(consume);
        let spend = Spend {
            input: input.id,
            lock_seq,
            salt: [salt; 16],
            outputs,
        };
        let (holder, env) =
            chain::spend_signing(&self.domain, &input, &spend).expect("device input");
        assert_eq!(holder, signer.public, "the signer owns the input");
        let sig = signer.sign(&env);
        let (holding, _) = chain::spend_outputs(&env, &input, &spend).expect("valid hop");
        let msg = Msg::Spend(spend);
        self.signed
            .push(sig_json(msg.kind(), &msg.body(), &sig, &signer.public));
        self.opens
            .push(open_json(&input, *self.salts.last().unwrap(), consume));
        self.holdings.push(holding);
        self.salts.push(spend.salt);
        self.slots.push(input.id);
        self.msgs.push(msg);
    }

    fn envelope(&self, i: usize) -> [u8; 96] {
        hash::envelope(
            &self.domain,
            &self.slots[i],
            &hash::content(&self.msgs[i].body()),
        )
    }

    fn replace(&mut self, i: usize, msg: Msg, signer: &Key) {
        if let Msg::Issue(issue) = &msg {
            self.slots[i] = issue.slot().unwrap_or_else(|_| {
                issue_slot(
                    issue.lock_seq,
                    issue.cum_end.wrapping_sub(issue.amount),
                    issue.cum_end,
                )
            });
        }
        self.msgs[i] = msg;
        let sig = signer.sign(&self.envelope(i));
        let msg = &self.msgs[i];
        self.signed[i] = sig_json(msg.kind(), &msg.body(), &sig, &signer.public);
    }

    fn mutate_spend(
        &mut self,
        i: usize,
        signer: Option<&Key>,
        f: impl FnOnce(&Output, &mut Spend),
    ) {
        let input = if self.opens[i].index == 0 {
            self.holdings[i - 1].first
        } else {
            self.holdings[i - 1].second.unwrap()
        };
        let Msg::Spend(mut spend) = self.msgs[i].clone() else {
            panic!("not a spend");
        };
        f(&input, &mut spend);
        let all = keys();
        let holder = all
            .iter()
            .find(|k| k.owner() == input.owner)
            .expect("known holder");
        self.replace(i, Msg::Spend(spend), signer.unwrap_or(holder));
    }

    fn mutate_issue(&mut self, signer: &Key, f: impl FnOnce(&mut Issue)) {
        let Msg::Issue(mut issue) = self.msgs[0].clone() else {
            panic!("not an issue");
        };
        f(&mut issue);
        self.replace(0, Msg::Issue(issue), signer);
    }

    fn message_id(&self, i: usize) -> [u8; 32] {
        hash::message_id(&self.envelope(i))
    }
}

fn dec(bytes: &[u8]) -> String {
    let mut digits = bytes.to_vec();
    let mut out = Vec::new();
    while digits.iter().any(|&d| d != 0) {
        let mut rem = 0u32;
        for d in digits.iter_mut() {
            let cur = (rem << 8) | u32::from(*d);
            *d = (cur / 10) as u8;
            rem = cur % 10;
        }
        out.push(b'0' + rem as u8);
    }
    if out.is_empty() {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn public_inputs(b: &Builder, i: usize) -> [String; 10] {
    let msg = &b.msgs[i];
    let is_issue = matches!(msg, Msg::Issue(_));
    let is_last = !is_issue && i + 1 == b.msgs.len();
    let next = b.opens.get(i + 1).map_or(0, |o| o.index);
    let ctrl = u32::from(is_issue) + 2 * u32::from(is_last) + 4 * u32::from(next);
    let e = b.message_id(i);
    let (mut a, mut mint) = ([0u8; 33], [0u8; 32]);
    let mut amt = 0u128;
    match msg {
        Msg::Issue(issue) => {
            a = issue.issuer;
            mint = issue.mint;
            amt = (u128::from(issue.amount) << 32) | u128::from(issue.lock_seq);
        }
        Msg::Spend(_) if is_last => {
            let out = b.holdings[i].first;
            a = out.owner.encode();
            amt = (u128::from(out.amount) << 32) | u128::from(out.caveats.expiry);
        }
        Msg::Spend(_) => {}
    }
    [
        dec(&e[..16]),
        dec(&e[16..]),
        ctrl.to_string(),
        String::new(),
        String::new(),
        dec(&a[..17]),
        dec(&a[17..]),
        dec(&mint[..16]),
        dec(&mint[16..]),
        dec(&amt.to_be_bytes()),
    ]
}

fn valid(name: &str, b: Builder) -> ValidChain {
    ValidChain {
        name: name.to_string(),
        message_ids: (0..b.msgs.len())
            .map(|i| hex::encode(b.message_id(i)))
            .collect(),
        output_ids: (0..b.msgs.len())
            .map(|i| {
                let id = b.message_id(i);
                [
                    hex::encode(hash::output_id(&id, 0)),
                    hex::encode(hash::output_id(&id, 1)),
                ]
            })
            .collect(),
        public: (0..b.msgs.len()).map(|i| public_inputs(&b, i)).collect(),
        messages: b.signed,
        openings: b.opens,
        #[cfg(test)]
        domain: b.domain,
        #[cfg(test)]
        slots: b.slots,
    }
}

fn base_issue(signer: &Key, caveats: Caveats) -> Issue {
    Issue {
        issuer: signer.public,
        mint: MINT,
        lock_seq: LOCK_SEQ,
        cum_end: 1_000_000,
        salt: [1; 16],
        owner: signer.owner(),
        amount: 1_000_000,
        caveats,
    }
}

fn domain() -> [u8; 32] {
    hash::domain(purpose::NOTE, &DEVNET_GENESIS_HASH, &PROGRAM)
}

fn pay_account(c: Caveats) -> Outputs {
    Outputs::One {
        owner: account(0xa0),
        caveats: c,
    }
}

fn pay_device(to: &Key, c: Caveats) -> Outputs {
    Outputs::One {
        owner: to.owner(),
        caveats: c,
    }
}

fn split(to: &Key, amount0: u64, caveats0: Caveats, from: &Key) -> Outputs {
    Outputs::Two {
        owner0: to.owner(),
        amount0,
        caveats0,
        owner1: from.owner(),
    }
}

const LOWER: u32 = EXPIRY - 2 * EXPIRY_STEP;

fn issue_only(k: &[Key; 4]) -> Builder {
    Builder::issue(&k[0], base_issue(&k[0], plain(EXPIRY, 4)))
}

fn issue_plus_1(k: &[Key; 4]) -> Builder {
    let mut b = issue_only(k);
    b.spend(&k[0], 0, pay_account(plain(EXPIRY, 0)), LOCK_SEQ, 2);
    b
}

fn issue_plus_2_prefix(k: &[Key; 4]) -> Builder {
    let mut b = issue_only(k);
    b.spend(
        &k[0],
        0,
        split(&k[1], 300_000, plain(LOWER, 3), &k[0]),
        LOCK_SEQ,
        2,
    );
    b
}

fn issue_plus_2(k: &[Key; 4], salt: u8) -> Builder {
    let mut b = issue_plus_2_prefix(k);
    b.spend(&k[1], 0, pay_account(plain(LOWER, 0)), LOCK_SEQ, salt);
    b
}

fn issue_plus_2_change(k: &[Key; 4]) -> Builder {
    let mut b = issue_plus_2_prefix(k);
    b.spend(&k[0], 1, pay_account(plain(EXPIRY, 0)), LOCK_SEQ, 3);
    b
}

fn issue_plus_2_single(k: &[Key; 4]) -> Builder {
    let mut b = issue_only(k);
    b.spend(&k[0], 0, pay_device(&k[1], plain(LOWER, 3)), LOCK_SEQ, 2);
    b.spend(&k[1], 0, pay_account(plain(LOWER, 0)), LOCK_SEQ, 3);
    b
}

fn merchant_lift(k: &[Key; 4]) -> Builder {
    let scope = k[1].owner().scope_hash();
    let scoped = |expiry, hops| caveats(expiry, hops, 0, ScopeKind::Merchant, scope);
    let mut b = Builder::issue(&k[0], base_issue(&k[0], scoped(EXPIRY, 4)));
    b.spend(&k[0], 0, pay_device(&k[1], scoped(LOWER, 3)), LOCK_SEQ, 2);
    b.spend(&k[1], 0, pay_account(plain(LOWER, 0)), LOCK_SEQ, 3);
    b
}

fn authority(k: &[Key; 4]) -> Builder {
    let scope = account(0xa0).scope_hash();
    let scoped = |hops| {
        caveats(
            EXPIRY,
            hops,
            flags::AUTHORITY_ONLY,
            ScopeKind::Authority,
            scope,
        )
    };
    let mut b = Builder::issue(&k[0], base_issue(&k[0], scoped(4)));
    b.spend(&k[0], 0, pay_account(scoped(3)), NO_LOCK, 2);
    b
}

fn delegated_no_lock(k: &[Key; 4]) -> Builder {
    let delegated = caveats(EXPIRY, 4, flags::DELEGATED, ScopeKind::Any, [0; 20]);
    let mut b = Builder::issue(&k[0], base_issue(&k[0], delegated));
    b.spend(&k[0], 0, pay_device(&k[1], plain(LOWER, 3)), NO_LOCK, 2);
    b.spend(&k[1], 0, pay_account(plain(LOWER, 0)), 9, 3);
    b
}

fn issue_plus_16(k: &[Key; 4]) -> Builder {
    let mut b = Builder::issue(&k[0], base_issue(&k[0], plain(EXPIRY, MAX_DEPTH)));
    for step in 0..16u8 {
        let consume = step % 2;
        let input = b.input(consume);
        let signer = k.iter().find(|key| key.owner() == input.owner).unwrap();
        let salt = 10 + step;
        if input.caveats.hops_left == 1 {
            b.spend(
                signer,
                consume,
                pay_account(plain(input.caveats.expiry, 0)),
                LOCK_SEQ,
                salt,
            );
        } else {
            let to = &k[(usize::from(step) + 1) % 4];
            let c = plain(
                input.caveats.expiry - EXPIRY_STEP,
                input.caveats.hops_left - 1,
            );
            b.spend(
                signer,
                consume,
                split(to, input.amount / 2, c, signer),
                LOCK_SEQ,
                salt,
            );
        }
    }
    b
}

fn valid_chains(k: &[Key; 4]) -> Vec<(&'static str, Builder)> {
    vec![
        ("issue_only", issue_only(k)),
        ("issue_plus_1", issue_plus_1(k)),
        ("issue_plus_2", issue_plus_2(k, 3)),
        ("issue_plus_2_branch", issue_plus_2(k, 4)),
        ("issue_plus_2_change", issue_plus_2_change(k)),
        ("issue_plus_2_single", issue_plus_2_single(k)),
        ("issue_plus_16", issue_plus_16(k)),
        ("merchant_lift", merchant_lift(k)),
        ("authority", authority(k)),
        ("delegated_no_lock", delegated_no_lock(k)),
    ]
}

struct Case {
    name: String,
    reason: &'static str,
    builder: Builder,
    bad: usize,
    public_override: Option<Override>,
}

fn n_minus(sig: &[u8]) -> [u8; 32] {
    let (mut out, mut borrow) = ([0u8; 32], 0i16);
    for i in (0..32).rev() {
        let d = i16::from(ORDER[i]) - i16::from(sig[i]) - borrow;
        borrow = i16::from(d < 0);
        out[i] = d.rem_euclid(256) as u8;
    }
    out
}

fn add_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (mut out, mut carry) = ([0u8; 32], 0u16);
    for i in (0..32).rev() {
        let s = u16::from(a[i]) + u16::from(b[i]) + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    assert_eq!(carry, 0, "x + p must fit in 256 bits");
    out
}

/// A device key with a tiny x, so that x + p still fits in 32 bytes: the second encoding of one
/// curve point, which the circuit must refuse.
fn aliased_key() -> [u8; 33] {
    let mut tiny = [0u8; 32];
    let mut sec1 = [0u8; 33];
    sec1[0] = 2;
    for x in 1u32.. {
        sec1[29..].copy_from_slice(&x.to_be_bytes());
        if PublicKey::from_sec1_bytes(&sec1).is_ok() {
            tiny[28..].copy_from_slice(&x.to_be_bytes());
            break;
        }
    }
    let mut out = [0u8; 33];
    out[0] = 2;
    out[1..].copy_from_slice(&add_be(&FIELD_PRIME, &tiny));
    out
}

fn set_sig(b: &mut Builder, i: usize, r: &[u8], s: &[u8]) {
    b.signed[i].sig_r = hex::encode(r);
    b.signed[i].sig_s = hex::encode(s);
}

fn cases(k: &[Key; 4]) -> Vec<Case> {
    let mut out = Vec::new();
    let mut add = |base: &str,
                   reason: &'static str,
                   builder: Builder,
                   bad: usize,
                   public_override: Option<Override>| {
        out.push(Case {
            name: format!("{base}/{reason}"),
            reason,
            builder,
            bad,
            public_override,
        });
    };

    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, Some(&k[2]), |_, _| {});
    add("issue_plus_2", "wrong_signer", b, 1, None);

    let mut b = issue_plus_2(k, 3);
    b.mutate_issue(&k[2], |_| {});
    add("issue_plus_2", "other_issuer_key", b, 0, None);

    let mut b = issue_plus_1(k);
    let r = hex::decode(&b.signed[1].sig_r).unwrap();
    let s = hex::decode(&b.signed[1].sig_s).unwrap();
    set_sig(&mut b, 1, &r, &n_minus(&s));
    add("issue_plus_1", "high_s", b, 1, None);

    let mut b = issue_plus_2(k, 3);
    b.opens[1].amount += 1;
    add("issue_plus_2", "altered_s_in", b, 1, None);

    let delta = |index, delta: &str| {
        Some(Override {
            index,
            delta: delta.to_string(),
        })
    };
    add(
        "issue_plus_2",
        "altered_e",
        issue_plus_2(k, 3),
        1,
        delta(1, "1"),
    );

    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, None, |input, s| {
        if let Outputs::Two { amount0, .. } = &mut s.outputs {
            *amount0 = input.amount;
        }
    });
    add("issue_plus_2", "amount0_not_below_input", b, 1, None);

    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, None, |input, s| {
        if let Outputs::Two { caveats0, .. } = &mut s.outputs {
            caveats0.hops_left = input.caveats.hops_left;
        }
    });
    add("issue_plus_2", "hops_not_decreasing", b, 1, None);

    let mut b = issue_plus_1(k);
    b.mutate_spend(1, None, |input, s| {
        if let Outputs::One { caveats, .. } = &mut s.outputs {
            caveats.expiry = input.caveats.expiry + 1;
        }
    });
    add("issue_plus_1", "expiry_extended", b, 1, None);

    let mut b = merchant_lift(k);
    b.mutate_spend(1, None, |_, s| {
        if let Outputs::One { owner, .. } = &mut s.outputs {
            *owner = k[2].owner();
        }
    });
    add("merchant_lift", "merchant_scope", b, 1, None);

    let mut b = issue_plus_2_single(k);
    b.mutate_spend(1, None, |_, s| s.lock_seq = NO_LOCK);
    add(
        "issue_plus_2_single",
        "no_lock_without_delegation",
        b,
        1,
        None,
    );

    let mut b = issue_plus_1(k);
    b.mutate_spend(1, None, |_, s| {
        s.outputs = pay_device(&k[1], plain(LOWER, 0));
    });
    add("issue_plus_1", "last_pays_a_device", b, 1, None);

    let amount = (1u64 << 32).to_string();
    add(
        "issue_plus_1",
        "altered_payment_amount",
        issue_plus_1(k),
        1,
        delta(9, &amount),
    );

    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, None, |_, s| {
        if let Outputs::Two { owner1, .. } = &mut s.outputs {
            *owner1 = k[2].owner();
        }
    });
    add("issue_plus_2", "change_to_other_key", b, 1, None);

    let alias = aliased_key();
    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, None, |_, s| {
        if let Outputs::Two { owner0, .. } = &mut s.outputs {
            *owner0 = Owner::Device(alias);
        }
    });
    add("issue_plus_2", "key_x_not_below_p", b, 1, None);

    let zero = [0u8; 32];
    let base = issue_plus_1(k);
    let r = hex::decode(&base.signed[1].sig_r).unwrap();
    let s = hex::decode(&base.signed[1].sig_s).unwrap();
    for (reason, sig_r, sig_s) in [
        ("r_zero", &zero[..], &s[..]),
        ("s_zero", &r[..], &zero[..]),
        ("r_not_below_n", &ORDER[..], &s[..]),
        ("s_not_below_n", &r[..], &ORDER[..]),
    ] {
        let mut b = base.clone();
        set_sig(&mut b, 1, sig_r, sig_s);
        add("issue_plus_1", reason, b, 1, None);
    }

    let mut b = issue_plus_1(k);
    let e = <Scalar as Reduce<FieldBytes>>::reduce(&b.message_id(1).into());
    let d = *k[0].signing.as_nonzero_scalar().as_ref();
    let r = -(e * d.invert().unwrap());
    let mut one = [0u8; 32];
    one[31] = 1;
    set_sig(&mut b, 1, &r.to_repr(), &one);
    add("issue_plus_1", "recovered_point_at_infinity", b, 1, None);

    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, None, |input, s| {
        if let Outputs::Two { caveats0, .. } = &mut s.outputs {
            caveats0.expiry = input.caveats.expiry - EXPIRY_STEP / 2;
        }
    });
    add("issue_plus_2", "expiry_step", b, 1, None);

    let mut b = issue_plus_2(k, 3);
    b.mutate_spend(1, None, |_, s| {
        if let Outputs::Two { amount0, .. } = &mut s.outputs {
            *amount0 = 0;
        }
    });
    add("issue_plus_2", "amount0_zero", b, 1, None);

    let mut b = issue_plus_1(k);
    b.mutate_issue(&k[0], |i| i.lock_seq = NO_LOCK);
    add("issue_plus_1", "issue_lock_none", b, 0, None);

    let mut b = issue_plus_1(k);
    b.mutate_issue(&k[0], |i| i.caveats.hops_left = MAX_DEPTH + 1);
    add("issue_plus_1", "issue_hops_above_max", b, 0, None);

    let mut b = issue_plus_1(k);
    b.mutate_issue(&k[0], |i| i.cum_end = i.amount - 1);
    add("issue_plus_1", "cum_end_below_amount", b, 0, None);

    let mut b = issue_plus_1(k);
    b.mutate_spend(1, None, |_, s| {
        if let Outputs::One { caveats, .. } = &mut s.outputs {
            caveats.flags = 4;
        }
    });
    add("issue_plus_1", "unknown_flag", b, 1, None);

    let mut b = issue_plus_2_single(k);
    b.mutate_spend(1, None, |_, s| {
        if let Outputs::One { caveats, .. } = &mut s.outputs {
            caveats.scope_kind = ScopeKind::Authority;
            caveats.scope = k[1].owner().scope_hash();
        }
    });
    add("issue_plus_2_single", "device_authority", b, 1, None);

    out
}

fn generate() -> Vectors {
    let k = keys();
    let valid = valid_chains(&k)
        .into_iter()
        .map(|(name, b)| valid(name, b))
        .collect();
    let invalid = cases(&k)
        .into_iter()
        .map(|c| InvalidCase {
            name: c.name,
            reason: c.reason.to_string(),
            messages: c.builder.signed,
            openings: c.builder.opens,
            bad: c.bad,
            public_override: c.public_override,
        })
        .collect();
    Vectors {
        domain: hex::encode(domain()),
        valid,
        invalid,
    }
}

fn render(v: &Vectors) -> String {
    let mut text = serde_json::to_string_pretty(v).expect("serializable");
    text.push('\n');
    text
}

#[cfg(test)]
fn envelope_of(chain: &ValidChain, i: usize) -> [u8; 96] {
    let body = hex::decode(&chain.messages[i].body).unwrap();
    hash::envelope(&chain.domain, &chain.slots[i], &hash::content(&body))
}

#[cfg(test)]
/// Replays a chain through the protocol crate: decodes every body, applies the rules of each hop,
/// verifies each signature and checks the recorded openings against the outputs.
fn verify_with_protocol(chain: &ValidChain) -> Result<(), String> {
    let err = |e: buckspay_protocol::ProtocolError| format!("{e:?}");
    let mut holding: Option<Holding> = None;
    for (i, m) in chain.messages.iter().enumerate() {
        let body = hex::decode(&m.body).map_err(|e| e.to_string())?;
        let env = envelope_of(chain, i);
        let key: [u8; 33] = hex::decode(&m.key).unwrap().try_into().unwrap();
        let sig: [u8; 64] = hex::decode(format!("{}{}", m.sig_r, m.sig_s))
            .unwrap()
            .try_into()
            .unwrap();
        buckspay_protocol::verify::verify_signature(&key, &env, &sig).map_err(err)?;
        let Some(held) = holding else {
            let issue = Issue::decode_body(&body).map_err(err)?;
            let (expect, output) = chain::issue_signing(&chain.domain, &issue).map_err(err)?;
            if issue.issuer != key || expect != env {
                return Err("issue: signer or envelope".into());
            }
            holding = Some(Holding {
                first: output,
                second: None,
            });
            continue;
        };
        let open = &chain.openings[i];
        let input = if open.index == 0 {
            held.first
        } else {
            held.second.ok_or("no change output")?
        };
        let spend = Spend::decode(input.id, &body).map_err(err)?;
        let (holder, expect) = chain::spend_signing(&chain.domain, &input, &spend).map_err(err)?;
        if holder != key || expect != env {
            return Err(format!("spend {i}: signer or envelope"));
        }
        if hex::encode(input.owner.encode()) != open.owner
            || input.amount != open.amount
            || hex::encode(input.caveats.encode()) != open.caveats
        {
            return Err(format!("opening {i} differs from the output"));
        }
        holding = Some(chain::spend_outputs(&env, &input, &spend).map_err(err)?.0);
    }
    Ok(())
}

fn main() {
    let path = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: zk-vectors <vectors.json>"),
    );
    fs::write(path, render(&generate())).expect("write vectors");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_invalid_case_breaks_exactly_one_message() {
        let v = generate();
        let reasons: std::collections::BTreeSet<_> =
            v.invalid.iter().map(|c| c.reason.as_str()).collect();
        for required in REQUIRED_REASONS {
            assert!(reasons.contains(required), "no case for {required}");
        }
        for case in &v.invalid {
            let valid = v
                .valid
                .iter()
                .find(|c| case.name.split('/').next() == Some(c.name.as_str()))
                .expect("derived from a valid chain");
            assert_eq!(case.messages.len(), valid.messages.len(), "{}", case.name);
            let differing: Vec<usize> = (0..case.messages.len())
                .filter(|&i| {
                    case.messages[i] != valid.messages[i]
                        || case.openings.get(i) != valid.openings.get(i)
                })
                .collect();
            if case.public_override.is_none() {
                assert_eq!(differing, vec![case.bad], "{}", case.name);
            } else {
                assert!(differing.is_empty(), "{}", case.name);
            }
        }
    }

    #[test]
    fn valid_chains_pass_the_protocol_crate() {
        for chain in generate().valid {
            assert!(verify_with_protocol(&chain).is_ok(), "{}", chain.name);
        }
    }

    #[test]
    fn output_ids_match_the_protocol_crate() {
        for chain in generate().valid {
            for i in 0..chain.messages.len() {
                let id = buckspay_protocol::hash::message_id(&envelope_of(&chain, i));
                assert_eq!(hex::encode(id), chain.message_ids[i]);
                for bit in 0..2u8 {
                    assert_eq!(
                        hex::encode(buckspay_protocol::hash::output_id(&id, bit)),
                        chain.output_ids[i][bit as usize]
                    );
                }
            }
        }
    }

    #[test]
    fn generation_is_deterministic() {
        assert_eq!(render(&generate()), render(&generate()));
    }

    #[test]
    fn expiry_step_is_the_production_window() {
        assert_eq!(buckspay_protocol::lock::EXPIRY_STEP, 3600);
    }
}
