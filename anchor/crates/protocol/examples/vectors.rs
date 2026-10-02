use buckspay_protocol::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};
use buckspay_protocol::device::{device_binding_body, device_binding_envelope};
use buckspay_protocol::hash::{content, domain, envelope, message_id, output_id, purpose};
use buckspay_protocol::verify::{
    recover_issue_signer, recover_spend_signer, recovery_id, verify_issue_conflict, verify_payment,
    verify_settlement, verify_spend_conflict, Attester, Received, Receiver, Settled,
};
use buckspay_protocol::{
    flags, kind, BondTicket, Caveats, Issue, IssueClaim, IssueConflict, Outputs, Owner,
    ProtocolError, ScopeKind, Signed, Spend, SpendConflict, CHALLENGE, GRACE, NO_LOCK, VERSION,
};
use curve25519_dalek::constants::EIGHT_TORSION;
use curve25519_dalek::{EdwardsPoint, Scalar};
use ed25519_dalek::Signer as _;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};

const PROGRAM_ID: [u8; 32] = [0xb0; 32];
const NOW: u32 = 1_800_000_000;
const EXPIRY: u32 = 1_900_000_000;
const MIN_WINDOW: u32 = 86_400;
const LOCK_UNTIL: u32 = EXPIRY + GRACE + CHALLENGE;
const MINT: [u8; 32] = [3; 32];
const ATTESTER_SEED: [u8; 32] = [0xa7; 32];
const ORGANISER_ADDRESS: [u8; 32] = [0xa0; 32];
const ORGANISER: Owner = Owner::Account(ORGANISER_ADDRESS);
const MERCHANT_ADDRESS: [u8; 32] = [0xb5; 32];
const MERCHANT_ACCOUNT: Owner = Owner::Account(MERCHANT_ADDRESS);
const PURPOSES: [(&str, &[u8]); 9] = [
    ("note", purpose::NOTE),
    ("ticket", purpose::TICKET),
    ("device", purpose::DEVICE),
    ("witness", purpose::WITNESS),
    ("reclaim", purpose::RECLAIM),
    ("payword", purpose::PAYWORD),
    ("iou", purpose::IOU),
    ("voice", purpose::VOICE),
    ("claim", purpose::CLAIM),
];

struct Key {
    name: &'static str,
    seed: u8,
    signing: SigningKey,
    public: [u8; 33],
}

impl Key {
    fn new(name: &'static str, seed: u8) -> Key {
        let signing = SigningKey::from_slice(&[seed; 32]).unwrap();
        let mut public = [0; 33];
        public.copy_from_slice(signing.verifying_key().to_sec1_point(true).as_bytes());
        Key {
            name,
            seed,
            signing,
            public,
        }
    }

    fn owner(&self) -> Owner {
        Owner::Device(self.public)
    }

    fn sign(&self, message: &[u8]) -> [u8; 64] {
        let signature: Signature = self.signing.sign(message);
        signature.normalize_s().to_bytes().into()
    }
}

struct Domains {
    note: [u8; 32],
    ticket: [u8; 32],
    attesters: [Attester; 2],
    attester: ed25519_dalek::SigningKey,
}

impl Domains {
    fn receiver(&self, me: Owner, now: u32) -> Receiver<'_> {
        Receiver {
            note_domain: self.note,
            ticket_domain: self.ticket,
            attesters: &self.attesters,
            me,
            now,
            min_window: MIN_WINDOW,
            accept_category: false,
            accept_authorities: &[],
        }
    }

    fn sign(&self, ticket: BondTicket) -> BondTicket {
        let message = ticket.signed_message(&self.ticket);
        BondTicket {
            signature: self.attester.sign(&message).to_bytes(),
            ..ticket
        }
    }

    /// Signs `ticket` as an attester with key `key`, secret scalar `secret` and nonce point
    /// `nonce`, the way only a malicious attester can: `s = r + k·secret`.
    fn forge(
        &self,
        ticket: BondTicket,
        key: EdwardsPoint,
        nonce: Scalar,
        r: EdwardsPoint,
    ) -> BondTicket {
        let key = key.compress().to_bytes();
        let r = r.compress().to_bytes();
        let k = challenge(&r, &key, &ticket.signed_message(&self.ticket));
        let s = nonce + k * self.attester.to_scalar();
        let mut signature = [0; 64];
        signature[..32].copy_from_slice(&r);
        signature[32..].copy_from_slice(&s.to_bytes());
        BondTicket {
            signature,
            ..ticket
        }
    }
}

fn challenge(r: &[u8; 32], key: &[u8; 32], message: &[u8]) -> Scalar {
    let digest = Sha512::new()
        .chain_update(r)
        .chain_update(key)
        .chain_update(message)
        .finalize();
    let mut wide = [0; 64];
    wide.copy_from_slice(&digest);
    Scalar::from_bytes_mod_order_wide(&wide)
}

fn ticket(device: &Key, bond: u64, backing: u64) -> BondTicket {
    BondTicket {
        device: device.public,
        mint: MINT,
        lock_seq: 0,
        bond,
        backing,
        lock_until: LOCK_UNTIL,
        attester: 1,
        signature: [0; 64],
    }
}

fn device_binding(
    name: &str,
    domain: &[u8; 32],
    wallet: &[u8; 32],
    device: &Key,
    key: [u8; 33],
) -> Value {
    let (body, envelope, signature, error) = match device_binding_envelope(domain, wallet, &key) {
        Ok(envelope) => (
            hex(&device_binding_body(wallet, &key).unwrap()),
            hex(&envelope),
            hex(&device.sign(&envelope)),
            String::new(),
        ),
        Err(error) => (
            String::new(),
            String::new(),
            String::new(),
            format!("{error:?}"),
        ),
    };
    json!({
        "name": name,
        "wallet": hex(wallet),
        "device": hex(&key),
        "body": body,
        "envelope": envelope,
        "signature": signature,
        "error": error,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn high_s(signature: &[u8; 64]) -> [u8; 64] {
    let (r, s) = Signature::from_slice(signature).unwrap().split_scalars();
    Signature::from_scalars(r, -*s).unwrap().to_bytes().into()
}

fn caveats(hops_left: u8) -> Caveats {
    Caveats {
        expiry: EXPIRY,
        hops_left,
        flags: 0,
        scope_kind: ScopeKind::Any,
        scope: [0; 20],
    }
}

fn sign_issue(domain: &[u8; 32], issuer: &Key, message: Issue) -> Signed<Issue> {
    let env = envelope(domain, &message.slot().unwrap(), &content(&message.body()));
    Signed {
        message,
        signature: issuer.sign(&env),
    }
}

fn issue(domain: &[u8; 32], issuer: &Key, owner: Owner, cum_end: u64) -> Signed<Issue> {
    issue_with(domain, issuer, owner, cum_end, caveats(4))
}

fn issue_with(
    domain: &[u8; 32],
    issuer: &Key,
    owner: Owner,
    cum_end: u64,
    caveats: Caveats,
) -> Signed<Issue> {
    let message = Issue {
        issuer: issuer.public,
        mint: MINT,
        lock_seq: 0,
        cum_end,
        salt: [4; 16],
        owner,
        amount: 20_000,
        caveats,
    };
    sign_issue(domain, issuer, message)
}

fn spend(
    domain: &[u8; 32],
    holder: &Key,
    input: &[u8; 32],
    lock_seq: u32,
    outputs: Outputs,
) -> Signed<Spend> {
    let message = Spend {
        input: *input,
        lock_seq,
        salt: [6; 16],
        outputs,
    };
    let env = envelope(domain, input, &message.content());
    Signed {
        message,
        signature: holder.sign(&env),
    }
}

fn issued_id(domain: &[u8; 32], issue: &Signed<Issue>) -> [u8; 32] {
    let message = &issue.message;
    let env = envelope(domain, &message.slot().unwrap(), &content(&message.body()));
    output_id(&message_id(&env), 0)
}

fn spent_id(domain: &[u8; 32], spend: &Signed<Spend>, index: u8) -> [u8; 32] {
    let env = envelope(domain, &spend.message.input, &spend.message.content());
    output_id(&message_id(&env), index)
}

fn spend_wire(spend: &Signed<Spend>) -> Vec<u8> {
    let mut out = [0; Spend::SPEND2_WIRE_LEN];
    let len = spend.encode(&mut out);
    out[..len].to_vec()
}

fn spends_hex(spends: &[Signed<Spend>]) -> Vec<String> {
    spends.iter().map(|s| hex(&spend_wire(s))).collect()
}

fn tickets_hex(tickets: &[BondTicket]) -> Vec<String> {
    tickets.iter().map(|t| hex(&t.encode())).collect()
}

fn addresses_hex(addresses: &[[u8; 32]]) -> Vec<String> {
    addresses.iter().map(|a| hex(a)).collect()
}

fn claim(issue: &Signed<Issue>) -> IssueClaim {
    let (start, end) = issue.message.interval().unwrap();
    IssueClaim {
        lock_seq: issue.message.lock_seq,
        start,
        end,
        content: content(&issue.message.body()),
        signature: issue.signature,
    }
}

fn recovery(key: &Key, (a, b): ([u8; 96], [u8; 96]), signatures: [&[u8; 64]; 2]) -> u8 {
    recovery_id(&key.public, &a, signatures[0]).unwrap()
        | recovery_id(&key.public, &b, signatures[1]).unwrap() << 2
}

fn issue_note(domain: &[u8; 32], issue: &Signed<Issue>) -> Value {
    let body = issue.message.body();
    note(
        "issue",
        domain,
        kind::ISSUE,
        &issue.encode(),
        issue.message.slot().unwrap(),
        content(&body),
        1,
    )
}

fn spend_note(name: &str, domain: &[u8; 32], spend: &Signed<Spend>) -> Value {
    let (kind, outputs) = match spend.message.outputs {
        Outputs::One { .. } => (kind::SPEND1, 1),
        Outputs::Two { .. } => (kind::SPEND2, 2),
    };
    let wire = spend_wire(spend);
    note(
        name,
        domain,
        kind,
        &wire,
        spend.message.input,
        spend.message.content(),
        outputs,
    )
}

fn note(
    name: &str,
    domain: &[u8; 32],
    kind: u8,
    wire: &[u8],
    slot: [u8; 32],
    content: [u8; 32],
    outputs: u8,
) -> Value {
    let env = envelope(domain, &slot, &content);
    let id = message_id(&env);
    let output_ids: Vec<String> = (0..outputs).map(|i| hex(&output_id(&id, i))).collect();
    json!({
        "name": name,
        "kind": kind,
        "wire": hex(wire),
        "content": hex(&content),
        "slot": hex(&slot),
        "envelope": hex(&env),
        "message_id": hex(&id),
        "output_ids": output_ids,
    })
}

fn payment(
    name: &str,
    receiver: &Receiver,
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
    tickets: &[BondTicket],
) -> Value {
    let received = verify_payment(receiver, issue, spends, tickets)
        .unwrap_or_else(|e| panic!("{name}: {e:?}"));
    json!({
        "name": name,
        "now": receiver.now,
        "min_window": receiver.min_window,
        "accept_category": receiver.accept_category,
        "accept_authorities": addresses_hex(receiver.accept_authorities),
        "me": hex(&receiver.me.encode()),
        "issue": hex(&issue.encode()),
        "spends": spends_hex(spends),
        "tickets": tickets_hex(tickets),
        "result": received_json(&received),
    })
}

fn settled_json(settled: &Settled) -> Value {
    json!({
        "owner": hex(&settled.output.owner.encode()),
        "amount": settled.output.amount.to_string(),
        "output_id": hex(&settled.output.id),
        "mint": hex(&settled.mint),
        "issuer": hex(&settled.issuer),
        "lock_seq": settled.lock_seq,
    })
}

fn received_json(received: &Received) -> Value {
    let mut value = settled_json(&Settled {
        output: received.output,
        mint: received.mint,
        issuer: received.issuer,
        lock_seq: received.lock_seq,
    });
    let liable: Vec<Value> = received
        .liable
        .iter()
        .map(|lock| {
            json!({
                "device": hex(&lock.device),
                "lock_seq": lock.lock_seq,
                "bond": lock.bond.to_string(),
            })
        })
        .collect();
    value["liable"] = json!(liable);
    value
}

fn settlement(
    name: &str,
    domain: &[u8; 32],
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
) -> Value {
    let (result, error) = match verify_settlement(domain, issue, spends) {
        Ok(settled) => (settled_json(&settled), String::new()),
        Err(error) => (Value::Null, format!("{error:?}")),
    };
    json!({
        "name": name,
        "issue": hex(&issue.encode()),
        "spends": spends_hex(spends),
        "result": result,
        "error": error,
    })
}

struct Invalid<'a> {
    name: &'a str,
    kind: u8,
    wire: Vec<u8>,
    spends: Vec<Signed<Spend>>,
    tickets: Vec<BondTicket>,
    me: Owner,
    now: u32,
    accept_authorities: &'a [[u8; 32]],
    error: ProtocolError,
}

fn invalid(domains: &Domains, case: Invalid) -> Value {
    let receiver = Receiver {
        accept_authorities: case.accept_authorities,
        ..domains.receiver(case.me, case.now)
    };
    let result = if case.kind == kind::ISSUE {
        Signed::<Issue>::decode(&case.wire).and_then(|issue| {
            verify_payment(&receiver, &issue, &case.spends, &case.tickets).map(drop)
        })
    } else {
        Signed::<Spend>::decode(&case.wire).map(drop)
    };
    assert_eq!(result, Err(case.error), "{}", case.name);
    json!({
        "name": case.name,
        "kind": case.kind,
        "wire": hex(&case.wire),
        "now": receiver.now,
        "min_window": receiver.min_window,
        "accept_category": receiver.accept_category,
        "accept_authorities": addresses_hex(receiver.accept_authorities),
        "me": hex(&receiver.me.encode()),
        "spends": spends_hex(&case.spends),
        "tickets": tickets_hex(&case.tickets),
        "error": format!("{:?}", case.error),
    })
}

fn conflict(name: &str, wire: &[u8], signer: &Key, result: Result<(), ProtocolError>) -> Value {
    let error = match result {
        Ok(()) => String::new(),
        Err(error) => format!("{error:?}"),
    };
    json!({ "name": name, "wire": hex(wire), "signer": hex(&signer.public), "error": error })
}

fn spend_conflict_result(
    domain: &[u8; 32],
    signer: &Key,
    wire: &[u8],
) -> Result<(), ProtocolError> {
    let conflict = SpendConflict::decode(wire)?;
    let recovered = recover_spend_signer(domain, &conflict)?;
    assert_eq!(recovered, signer.public);
    verify_spend_conflict(domain, &recovered, &conflict)
}

fn issue_conflict_result(
    domain: &[u8; 32],
    signer: &Key,
    wire: &[u8],
) -> Result<(), ProtocolError> {
    let conflict = IssueConflict::decode(wire)?;
    let recovered = recover_issue_signer(domain, &conflict)?;
    assert_eq!(recovered, signer.public);
    verify_issue_conflict(domain, &recovered, &conflict)
}

fn vectors() -> Value {
    let attester = ed25519_dalek::SigningKey::from_bytes(&ATTESTER_SEED);
    let honest_key = attester.verifying_key().to_edwards();
    let mixed_key = honest_key + EIGHT_TORSION[1];
    let domains = Domains {
        note: domain(purpose::NOTE, &DEVNET_GENESIS_HASH, &PROGRAM_ID),
        ticket: domain(purpose::TICKET, &DEVNET_GENESIS_HASH, &PROGRAM_ID),
        attesters: [
            Attester {
                id: 1,
                key: attester.verifying_key().to_bytes(),
            },
            Attester {
                id: 2,
                key: mixed_key.compress().to_bytes(),
            },
        ],
        attester,
    };
    let domain = &domains.note;
    let foreign_domain =
        buckspay_protocol::hash::domain(purpose::NOTE, &DEVNET_GENESIS_HASH, &[0xb1; 32]);
    let issuer = Key::new("issuer", 1);
    let alice = Key::new("alice", 2);
    let bob = Key::new("bob", 3);
    let carol = Key::new("carol", 4);
    let mallory = Key::new("mallory", 5);

    let issuer_ticket = domains.sign(ticket(&issuer, 1_000_000, 40_000));
    let alice_ticket = domains.sign(ticket(&alice, 20_000, 0));
    let bob_ticket = domains.sign(ticket(&bob, 20_000, 0));
    let tickets = [issuer_ticket, alice_ticket, bob_ticket];
    let one_hop = [issuer_ticket, alice_ticket];
    let issuer_only = [issuer_ticket];

    let issued = issue(domain, &issuer, alice.owner(), 20_000);
    let first = issued_id(domain, &issued);
    let pay_bob = |holder: &Key, amount0: u64, caveats0: Caveats, owner1: &Key, lock_seq| {
        let outputs = Outputs::Two {
            owner0: bob.owner(),
            amount0,
            caveats0,
            owner1: owner1.owner(),
        };
        spend(domain, holder, &first, lock_seq, outputs)
    };
    let pay_carol = |holder: &Key, input: &[u8; 32]| {
        let outputs = Outputs::One {
            owner: carol.owner(),
            caveats: caveats(2),
        };
        spend(domain, holder, input, 0, outputs)
    };

    let to_bob = pay_bob(&alice, 12_000, caveats(3), &alice, 0);
    let to_carol = pay_carol(&bob, &spent_id(domain, &to_bob, 0));
    let change_to_carol = pay_carol(&alice, &spent_id(domain, &to_bob, 1));

    let delegated = issue_with(
        domain,
        &issuer,
        alice.owner(),
        20_000,
        Caveats {
            flags: flags::DELEGATED,
            ..caveats(4)
        },
    );
    let delegated_output = issued_id(domain, &delegated);
    let delegated_to_bob = |flags: u8| {
        let outputs = Outputs::One {
            owner: bob.owner(),
            caveats: Caveats {
                flags,
                ..caveats(3)
            },
        };
        spend(domain, &alice, &delegated_output, NO_LOCK, outputs)
    };
    let redeemable = Caveats {
        flags: flags::AUTHORITY_ONLY,
        scope_kind: ScopeKind::Authority,
        scope: ORGANISER.scope_hash(),
        ..caveats(4)
    };
    let for_authority = issue_with(domain, &issuer, alice.owner(), 20_000, redeemable);
    let trusts_organiser = [ORGANISER_ADDRESS];
    let trusts_merchant = [MERCHANT_ADDRESS];
    let redemption = spend(
        domain,
        &alice,
        &issued_id(domain, &for_authority),
        NO_LOCK,
        Outputs::Two {
            owner0: ORGANISER,
            amount0: 5_000,
            caveats0: Caveats {
                hops_left: 3,
                ..redeemable
            },
            owner1: alice.owner(),
        },
    );
    let merchant_only = Caveats {
        scope_kind: ScopeKind::Merchant,
        scope: bob.owner().scope_hash(),
        ..caveats(4)
    };
    let for_bob = issue_with(domain, &issuer, alice.owner(), 20_000, merchant_only);
    let for_bob_output = issued_id(domain, &for_bob);
    let merchant_payment = |payee: &Key| {
        let outputs = Outputs::One {
            owner: payee.owner(),
            caveats: Caveats {
                hops_left: 3,
                ..merchant_only
            },
        };
        spend(domain, &alice, &for_bob_output, 0, outputs)
    };
    let to_merchant = merchant_payment(&bob);
    let merchant_settles = spend(
        domain,
        &bob,
        &spent_id(domain, &to_merchant, 0),
        0,
        Outputs::One {
            owner: MERCHANT_ACCOUNT,
            caveats: caveats(2),
        },
    );
    let bob_settles = spend(
        domain,
        &bob,
        &spent_id(domain, &to_bob, 0),
        NO_LOCK,
        Outputs::One {
            owner: MERCHANT_ACCOUNT,
            caveats: caveats(2),
        },
    );

    let issued_wire = issued.encode();
    let high_s_issue = Signed {
        signature: high_s(&issued.signature),
        ..issued
    };
    let to_account = sign_issue(
        domain,
        &issuer,
        Issue {
            owner: Owner::Account([5; 32]),
            ..issued.message
        },
    );
    let account_output = issued_id(domain, &to_account);
    let foreign = issue(&foreign_domain, &issuer, alice.owner(), 20_000);
    let with_caveats =
        |caveats: Caveats| issue_with(domain, &issuer, alice.owner(), 20_000, caveats);
    let unknown_flag = with_caveats(Caveats {
        flags: 0b100,
        ..caveats(4)
    });
    let non_canonical = with_caveats(Caveats {
        scope: [1; 20],
        ..caveats(4)
    });
    let mut off_curve = [0xff; 33];
    off_curve[0] = 0x02;
    let off_curve = issue(domain, &issuer, Owner::Device(off_curve), 20_000);
    let unbacked = issue(domain, &issuer, alice.owner(), 50_000);
    let mut reserved_owner = issued_wire;
    reserved_owner[95] = 0x01;
    let mut bad_version = issued_wire;
    bad_version[0] = VERSION + 1;
    let to_bob_wire = spend_wire(&to_bob);
    let zero_payment = spend_wire(&Signed {
        message: Spend {
            outputs: Outputs::Two {
                owner0: bob.owner(),
                amount0: 0,
                caveats0: caveats(3),
                owner1: alice.owner(),
            },
            ..to_bob.message
        },
        signature: to_bob.signature,
    });
    let with_alice = |alice_ticket: BondTicket| [issuer_ticket, alice_ticket];
    let insufficient_bond = with_alice(domains.sign(ticket(&alice, 19_999, 0)));
    let short_lock = with_alice(domains.sign(BondTicket {
        lock_until: LOCK_UNTIL - 1,
        ..alice_ticket
    }));
    let forged = with_alice(BondTicket {
        bond: 1_000_000,
        ..alice_ticket
    });
    let other_mint = [domains.sign(BondTicket {
        mint: [4; 32],
        ..issuer_ticket
    })];
    let expiring = Caveats {
        expiry: NOW + MIN_WINDOW - 1,
        ..caveats(3)
    };
    let small_issuer_bond = [domains.sign(ticket(&issuer, 19_999, 40_000))];
    let unbonded_issuer = [domains.sign(ticket(&issuer, 0, 40_000))];
    let last_hop = with_caveats(caveats(1));
    let stranding_change = spend(
        domain,
        &alice,
        &issued_id(domain, &last_hop),
        0,
        Outputs::Two {
            owner0: bob.owner(),
            amount0: 12_000,
            caveats0: caveats(0),
            owner1: alice.owner(),
        },
    );
    let no_lock_issue = sign_issue(
        domain,
        &issuer,
        Issue {
            lock_seq: NO_LOCK,
            ..issued.message
        },
    );
    let mixed_order = |aligned: bool| {
        let unsigned = BondTicket {
            attester: 2,
            ..ticket(&issuer, 1_000_000, 40_000)
        };
        let message = unsigned.signed_message(&domains.ticket);
        let key = mixed_key.compress().to_bytes();
        (1u64..)
            .map(Scalar::from)
            .find_map(|nonce| {
                let r = EdwardsPoint::mul_base(&nonce);
                let k = challenge(&r.compress().to_bytes(), &key, &message);
                (k.as_bytes()[0].is_multiple_of(8) == aligned)
                    .then(|| domains.forge(unsigned, mixed_key, nonce, r))
            })
            .unwrap()
    };
    let small_order_nonce = domains.forge(
        ticket(&issuer, 1_000_000, 40_000),
        honest_key,
        Scalar::ZERO,
        EIGHT_TORSION[1],
    );
    let unsigned_issuer_ticket = BondTicket {
        signature: [0; 64],
        ..issuer_ticket
    };
    let unsigned_alice_ticket = BondTicket {
        signature: [0; 64],
        ..alice_ticket
    };
    let scoped_to_bob = |scope_kind, scope| {
        let caveats0 = Caveats {
            scope_kind,
            scope,
            ..caveats(3)
        };
        pay_bob(&alice, 12_000, caveats0, &alice, 0)
    };
    let mut category = [0; 20];
    category[..2].copy_from_slice(&7u16.to_le_bytes());
    let category_payment = scoped_to_bob(ScopeKind::Category, category);
    let delegating = pay_bob(
        &alice,
        12_000,
        Caveats {
            flags: flags::DELEGATED,
            ..caveats(3)
        },
        &alice,
        0,
    );
    let delegated_to_carol = spend(
        domain,
        &bob,
        &spent_id(domain, &delegating, 0),
        NO_LOCK,
        Outputs::One {
            owner: carol.owner(),
            caveats: caveats(2),
        },
    );
    let bob_as_authority = Caveats {
        scope: bob.owner().scope_hash(),
        ..redeemable
    };
    let to_device_authority = issue_with(domain, &issuer, bob.owner(), 20_000, bob_as_authority);
    let through_bob = issue_with(
        domain,
        &issuer,
        alice.owner(),
        20_000,
        Caveats {
            flags: flags::AUTHORITY_ONLY | flags::DELEGATED,
            ..bob_as_authority
        },
    );
    let device_authority_escape = spend(
        domain,
        &alice,
        &issued_id(domain, &through_bob),
        NO_LOCK,
        Outputs::One {
            owner: bob.owner(),
            caveats: Caveats {
                hops_left: 3,
                ..bob_as_authority
            },
        },
    );
    let invalid_cases = [
        issue_case(
            "high_s_issue",
            &high_s_issue.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Signature,
        ),
        issue_case(
            "wrong_signer",
            &issued_wire,
            &[pay_bob(&mallory, 12_000, caveats(3), &alice, 0)],
            &one_hop,
            &bob,
            ProtocolError::Signature,
        ),
        issue_case(
            "widened_caveats",
            &issued_wire,
            &[pay_bob(&alice, 12_000, caveats(4), &alice, 0)],
            &one_hop,
            &bob,
            ProtocolError::Attenuation,
        ),
        Invalid {
            now: EXPIRY + 1,
            ..issue_case(
                "expired",
                &issued_wire,
                &[to_bob],
                &one_hop,
                &bob,
                ProtocolError::Expired,
            )
        },
        issue_case(
            "payment_not_smaller",
            &issued_wire,
            &[pay_bob(&alice, 20_000, caveats(3), &alice, 0)],
            &one_hop,
            &bob,
            ProtocolError::Amount,
        ),
        issue_case(
            "broken_linkage",
            &issued_wire,
            &[to_carol],
            &one_hop,
            &carol,
            ProtocolError::Linkage,
        ),
        issue_case(
            "terminal_output_spent",
            &to_account.encode(),
            &[pay_carol(&alice, &account_output)],
            &one_hop,
            &carol,
            ProtocolError::Owner,
        ),
        issue_case(
            "foreign_domain",
            &foreign.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Signature,
        ),
        issue_case(
            "unknown_flag",
            &unknown_flag.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Flags,
        ),
        issue_case(
            "non_canonical_scope",
            &non_canonical.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Scope,
        ),
        issue_case(
            "reserved_owner",
            &reserved_owner,
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Owner,
        ),
        issue_case(
            "bad_version",
            &bad_version,
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Version,
        ),
        issue_case(
            "off_curve_owner",
            &off_curve.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Owner,
        ),
        issue_case(
            "no_lock_undelegated",
            &issued_wire,
            &[pay_bob(&alice, 12_000, caveats(3), &alice, NO_LOCK)],
            &one_hop,
            &bob,
            ProtocolError::Lock,
        ),
        issue_case(
            "redelegated_without_lock",
            &delegated.encode(),
            &[delegated_to_bob(flags::DELEGATED)],
            &one_hop,
            &bob,
            ProtocolError::Lock,
        ),
        issue_case(
            "change_to_someone_else",
            &issued_wire,
            &[pay_bob(&alice, 12_000, caveats(3), &mallory, 0)],
            &one_hop,
            &bob,
            ProtocolError::Change,
        ),
        issue_case(
            "scope_violation",
            &for_bob.encode(),
            &[merchant_payment(&carol)],
            &one_hop,
            &carol,
            ProtocolError::Scope,
        ),
        issue_case(
            "missing_ticket",
            &issued_wire,
            &[],
            &[],
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "unbacked_issue",
            &unbacked.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "other_mint_lock",
            &issued_wire,
            &[],
            &other_mint,
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "insufficient_bond",
            &issued_wire,
            &[to_bob],
            &insufficient_bond,
            &bob,
            ProtocolError::Ticket,
        ),
        issue_case(
            "short_lock",
            &issued_wire,
            &[to_bob],
            &short_lock,
            &bob,
            ProtocolError::Ticket,
        ),
        issue_case(
            "forged_ticket",
            &issued_wire,
            &[to_bob],
            &forged,
            &bob,
            ProtocolError::Ticket,
        ),
        issue_case(
            "not_addressed_to_me",
            &issued_wire,
            &[to_bob],
            &one_hop,
            &carol,
            ProtocolError::Payee,
        ),
        issue_case(
            "expiring_output",
            &issued_wire,
            &[pay_bob(&alice, 12_000, expiring, &alice, 0)],
            &one_hop,
            &bob,
            ProtocolError::Window,
        ),
        issue_case(
            "zero_hop_output",
            &issued_wire,
            &[pay_bob(&alice, 12_000, caveats(0), &alice, 0)],
            &one_hop,
            &bob,
            ProtocolError::Window,
        ),
        issue_case(
            "issuer_bond_too_small",
            &issued_wire,
            &[],
            &small_issuer_bond,
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "delegated_issue_unbonded",
            &delegated.encode(),
            &[delegated_to_bob(0)],
            &unbonded_issuer,
            &bob,
            ProtocolError::Ticket,
        ),
        issue_case(
            "own_change_is_not_a_payment",
            &issued_wire,
            &[to_bob],
            &one_hop,
            &alice,
            ProtocolError::Payee,
        ),
        issue_case(
            "change_without_a_hop",
            &last_hop.encode(),
            &[stranding_change],
            &one_hop,
            &bob,
            ProtocolError::Depth,
        ),
        issue_case(
            "issue_without_lock",
            &no_lock_issue.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Lock,
        ),
        issue_case(
            "mixed_order_attester",
            &issued_wire,
            &[],
            &[mixed_order(false)],
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "mixed_order_attester_cofactorless",
            &issued_wire,
            &[],
            &[mixed_order(true)],
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "small_order_nonce",
            &issued_wire,
            &[],
            &[small_order_nonce],
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "foreign_merchant_scope",
            &issued_wire,
            &[scoped_to_bob(
                ScopeKind::Merchant,
                carol.owner().scope_hash(),
            )],
            &one_hop,
            &bob,
            ProtocolError::Scope,
        ),
        issue_case(
            "foreign_authority_scope",
            &issued_wire,
            &[scoped_to_bob(ScopeKind::Authority, ORGANISER.scope_hash())],
            &one_hop,
            &bob,
            ProtocolError::Scope,
        ),
        issue_case(
            "category_not_accepted",
            &issued_wire,
            &[category_payment],
            &one_hop,
            &bob,
            ProtocolError::Scope,
        ),
        issue_case(
            "authority_note_to_a_device",
            &for_authority.encode(),
            &[],
            &issuer_only,
            &alice,
            ProtocolError::Scope,
        ),
        Invalid {
            accept_authorities: &trusts_merchant,
            ..issue_case(
                "authority_note_untrusted_authority",
                &for_authority.encode(),
                &[],
                &issuer_only,
                &alice,
                ProtocolError::Scope,
            )
        },
        Invalid {
            accept_authorities: &trusts_organiser,
            ..issue_case(
                "trusted_authority_scope_without_authority_only",
                &issued_wire,
                &[scoped_to_bob(ScopeKind::Authority, ORGANISER.scope_hash())],
                &one_hop,
                &bob,
                ProtocolError::Scope,
            )
        },
        issue_case(
            "authority_only_added_mid_chain",
            &issued_wire,
            &[pay_bob(
                &alice,
                12_000,
                Caveats {
                    hops_left: 3,
                    ..redeemable
                },
                &alice,
                0,
            )],
            &one_hop,
            &bob,
            ProtocolError::Attenuation,
        ),
        issue_case(
            "device_authority_issue",
            &to_device_authority.encode(),
            &[],
            &issuer_only,
            &bob,
            ProtocolError::Scope,
        ),
        issue_case(
            "device_authority_escape",
            &through_bob.encode(),
            &[device_authority_escape],
            &issuer_only,
            &bob,
            ProtocolError::Scope,
        ),
        Invalid {
            me: MERCHANT_ACCOUNT,
            ..issue_case(
                "unbonded_terminal_payment",
                &issued_wire,
                &[to_bob, bob_settles],
                &one_hop,
                &bob,
                ProtocolError::Lock,
            )
        },
        issue_case(
            "too_many_tickets",
            &issued_wire,
            &[],
            &one_hop,
            &alice,
            ProtocolError::Ticket,
        ),
        issue_case(
            "duplicate_tickets",
            &issued_wire,
            &[to_bob],
            &[unsigned_issuer_ticket, issuer_ticket],
            &bob,
            ProtocolError::Ticket,
        ),
        issue_case(
            "chain_too_long",
            &issued_wire,
            &[to_bob; 17],
            &[],
            &bob,
            ProtocolError::Depth,
        ),
        Invalid {
            kind: kind::SPEND2,
            ..issue_case(
                "truncated_spend",
                &to_bob_wire[..to_bob_wire.len() - 1],
                &[],
                &[],
                &bob,
                ProtocolError::Length,
            )
        },
        Invalid {
            kind: kind::SPEND2,
            ..issue_case(
                "zero_payment",
                &zero_payment,
                &[],
                &[],
                &bob,
                ProtocolError::Amount,
            )
        },
    ];

    let to_carol_too = pay_carol(&alice, &first);
    let envelopes = |spend: &Signed<Spend>| envelope(domain, &first, &spend.message.content());
    let equivocation = SpendConflict {
        slot: first,
        content_a: to_bob.message.content(),
        signature_a: to_bob.signature,
        content_b: to_carol_too.message.content(),
        signature_b: to_carol_too.signature,
        recovery: recovery(
            &alice,
            (envelopes(&to_bob), envelopes(&to_carol_too)),
            [&to_bob.signature, &to_carol_too.signature],
        ),
    };
    let malleated = SpendConflict {
        content_b: equivocation.content_a,
        signature_b: high_s(&equivocation.signature_a),
        recovery: equivocation.recovery & 3 | (equivocation.recovery & 3 ^ 1) << 2,
        ..equivocation
    };
    let mismatched = SpendConflict {
        recovery: equivocation.recovery ^ 0b0100,
        ..equivocation
    };
    let mut bad_recovery = equivocation.encode();
    bad_recovery[SpendConflict::WIRE_LEN - 1] = 0x10;
    let issue_conflict = |b: &Signed<Issue>| {
        let (a, b) = (claim(&issued), claim(b));
        let conflict = IssueConflict { a, b, recovery: 0 };
        IssueConflict {
            recovery: recovery(
                &issuer,
                conflict.envelopes(domain),
                [&a.signature, &b.signature],
            ),
            ..conflict
        }
    };
    let overlapping = issue_conflict(&issue(domain, &issuer, bob.owner(), 30_000));
    let adjacent = issue_conflict(&issue(domain, &issuer, bob.owner(), 40_000));

    let spend_conflicts = [
        ("equivocation", equivocation.encode()),
        ("malleated_copy", malleated.encode()),
        ("mismatched_recovery", mismatched.encode()),
        ("unknown_recovery_bits", bad_recovery),
    ]
    .map(|(name, wire)| {
        conflict(
            name,
            &wire,
            &alice,
            spend_conflict_result(domain, &alice, &wire),
        )
    });
    let issue_conflicts = [
        ("over_issuance", overlapping.encode()),
        ("adjacent_issues", adjacent.encode()),
    ]
    .map(|(name, wire)| {
        conflict(
            name,
            &wire,
            &issuer,
            issue_conflict_result(domain, &issuer, &wire),
        )
    });

    let mut domains_json = serde_json::Map::new();
    domains_json.insert("genesis_hash".into(), json!(hex(&DEVNET_GENESIS_HASH)));
    domains_json.insert("program_id".into(), json!(hex(&PROGRAM_ID)));
    for (name, purpose) in PURPOSES {
        let derived = buckspay_protocol::hash::domain(purpose, &DEVNET_GENESIS_HASH, &PROGRAM_ID);
        domains_json.insert(name.into(), json!(hex(&derived)));
    }
    let device_domain =
        buckspay_protocol::hash::domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &PROGRAM_ID);
    let uncompressed = {
        let mut key = alice.public;
        key[0] = 0x04;
        key
    };
    let account_owner = Owner::Account([0xa1; 32]).encode();
    let at = |me: Owner| domains.receiver(me, NOW);
    let keys = [&issuer, &alice, &bob, &carol, &mallory].map(|key| {
        json!({ "name": key.name, "secret": hex(&[key.seed; 32]), "public": hex(&key.public) })
    });
    json!({
        "version": VERSION,
        "clusters": {
            "devnet": hex(&DEVNET_GENESIS_HASH),
            "mainnet": hex(&MAINNET_GENESIS_HASH),
        },
        "domain": domains_json,
        "keys": keys,
        "attesters": [
            { "id": 1, "secret": hex(&ATTESTER_SEED), "public": hex(&domains.attesters[0].key) },
            { "id": 2, "secret": "", "public": hex(&domains.attesters[1].key) },
        ],
        "messages": [
            issue_note(domain, &issued),
            spend_note("spend2", domain, &to_bob),
            spend_note("spend1", domain, &to_carol),
        ],
        "tickets": [{
            "name": "bond_ticket",
            "wire": hex(&issuer_ticket.encode()),
            "signed_message": hex(&issuer_ticket.signed_message(&domains.ticket)),
        }],
        "payments": [
            payment("three_hops_with_change", &at(carol.owner()), &issued, &[to_bob, to_carol], &tickets),
            payment("spend_change_output", &at(carol.owner()), &issued, &[to_bob, change_to_carol], &one_hop),
            payment("direct_issue", &at(alice.owner()), &issued, &[], &issuer_only),
            payment("delegated_without_lock", &at(bob.owner()), &delegated, &[delegated_to_bob(0)], &issuer_only),
            payment("delegated_by_a_spender", &at(carol.owner()), &issued, &[delegating, delegated_to_carol], &one_hop),
            payment("authority_redemption", &at(ORGANISER), &for_authority, &[redemption], &issuer_only),
            payment("authority_note_to_trusted_attendee", &Receiver { accept_authorities: &trusts_organiser, ..at(alice.owner()) }, &for_authority, &[], &issuer_only),
            payment("merchant_scope", &at(bob.owner()), &for_bob, &[to_merchant], &one_hop),
            payment("merchant_settles", &at(MERCHANT_ACCOUNT), &for_bob, &[to_merchant, merchant_settles], &tickets),
            payment("category_accepted", &Receiver { accept_category: true, ..at(bob.owner()) }, &issued, &[category_payment], &one_hop),
            payment("skips_a_ticket_for_another_lock", &at(bob.owner()), &delegated, &[delegated_to_bob(0)], &[unsigned_alice_ticket, issuer_ticket]),
        ],
        "settlements": [
            settlement("merchant_settles", domain, &for_bob, &[to_merchant, merchant_settles]),
            settlement("authority_redemption", domain, &for_authority, &[redemption]),
            settlement("unbonded_receiver_settles", domain, &issued, &[to_bob, bob_settles]),
            settlement("issued_to_account", domain, &to_account, &[]),
            settlement("device_output", domain, &issued, &[to_bob]),
        ],
        "invalid": invalid_cases.into_iter().map(|case| invalid(&domains, case)).collect::<Vec<_>>(),
        "conflicts": spend_conflicts.into_iter().chain(issue_conflicts).collect::<Vec<_>>(),
        "device_bindings": [
            device_binding("alice_to_wallet", &device_domain, &[0xa1; 32], &alice, alice.public),
            device_binding("bob_to_merchant", &device_domain, &MERCHANT_ADDRESS, &bob, bob.public),
            device_binding("uncompressed_key", &device_domain, &[0xa1; 32], &alice, uncompressed),
            device_binding("account_as_key", &device_domain, &[0xa1; 32], &alice, account_owner),
        ],
    })
}

fn issue_case<'a>(
    name: &'a str,
    wire: &[u8],
    spends: &[Signed<Spend>],
    tickets: &[BondTicket],
    me: &Key,
    error: ProtocolError,
) -> Invalid<'a> {
    Invalid {
        name,
        kind: kind::ISSUE,
        wire: wire.to_vec(),
        spends: spends.to_vec(),
        tickets: tickets.to_vec(),
        me: me.owner(),
        now: NOW,
        accept_authorities: &[],
        error,
    }
}

pub fn render() -> String {
    let mut out = serde_json::to_string_pretty(&vectors()).unwrap();
    out.push('\n');
    out
}

fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/v1.json");
    std::fs::write(path, render()).unwrap();
}
