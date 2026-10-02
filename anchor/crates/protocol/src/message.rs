use crate::{hash, Caveats, Owner, ProtocolError, Result, MAX_DEPTH, VERSION};

pub mod kind {
    pub const ISSUE: u8 = 0x01;
    pub const SPEND1: u8 = 0x02;
    pub const SPEND2: u8 = 0x03;
    pub const BOND_TICKET: u8 = 0x10;
    pub const SPEND_CONFLICT: u8 = 0x20;
    pub const ISSUE_CONFLICT: u8 = 0x21;
    pub const DEVICE_BINDING: u8 = 0x50;
}

pub const NO_LOCK: u32 = u32::MAX;
/// Seconds after a note's expiry during which its payees can still settle it.
pub const GRACE: u32 = 7 * 24 * 60 * 60;
/// Seconds after the grace period during which conflicts are still accepted.
pub const CHALLENGE: u32 = 7 * 24 * 60 * 60;
const ISSUE_SLOT_TAG: &[u8; 4] = b"ISSU";

fn header(bytes: &[u8], expected_kind: u8) -> Result<()> {
    if bytes.first() != Some(&VERSION) {
        return Err(ProtocolError::Version);
    }
    if bytes.get(1) != Some(&expected_kind) {
        return Err(ProtocolError::Kind);
    }
    Ok(())
}

pub(crate) fn array<const N: usize>(bytes: &[u8], at: usize) -> [u8; N] {
    let mut out = [0; N];
    out.copy_from_slice(&bytes[at..at + N]);
    out
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(array(bytes, at))
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(array(bytes, at))
}

fn device(key: &[u8; 33]) -> Result<()> {
    match Owner::decode(key)? {
        Owner::Device(_) => Ok(()),
        Owner::Account(_) => Err(ProtocolError::Owner),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Signed<T> {
    pub message: T,
    pub signature: [u8; 64],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Issue {
    pub issuer: [u8; 33],
    pub mint: [u8; 32],
    pub lock_seq: u32,
    pub cum_end: u64,
    pub salt: [u8; 16],
    pub owner: Owner,
    pub amount: u64,
    pub caveats: Caveats,
}

impl Issue {
    pub const BODY_LEN: usize = 163;
    pub const WIRE_LEN: usize = Self::BODY_LEN + 64;

    pub fn body(&self) -> [u8; 163] {
        let mut out = [0; 163];
        out[0] = VERSION;
        out[1] = kind::ISSUE;
        out[2..35].copy_from_slice(&self.issuer);
        out[35..67].copy_from_slice(&self.mint);
        out[67..71].copy_from_slice(&self.lock_seq.to_le_bytes());
        out[71..79].copy_from_slice(&self.cum_end.to_le_bytes());
        out[79..95].copy_from_slice(&self.salt);
        out[95..128].copy_from_slice(&self.owner.encode());
        out[128..136].copy_from_slice(&self.amount.to_le_bytes());
        out[136..].copy_from_slice(&self.caveats.encode());
        out
    }

    pub fn decode_body(bytes: &[u8]) -> Result<Issue> {
        if bytes.len() != Self::BODY_LEN {
            return Err(ProtocolError::Length);
        }
        header(bytes, kind::ISSUE)?;
        let issue = Issue {
            issuer: array(bytes, 2),
            mint: array(bytes, 35),
            lock_seq: u32_at(bytes, 67),
            cum_end: u64_at(bytes, 71),
            salt: array(bytes, 79),
            owner: Owner::decode(&array(bytes, 95))?,
            amount: u64_at(bytes, 128),
            caveats: Caveats::decode(&array(bytes, 136))?,
        };
        issue.check()?;
        Ok(issue)
    }

    pub fn check(&self) -> Result<()> {
        device(&self.issuer)?;
        if self.amount == 0 {
            return Err(ProtocolError::Amount);
        }
        if self.lock_seq == NO_LOCK {
            return Err(ProtocolError::Lock);
        }
        self.caveats.check()?;
        self.caveats.check_holder(&self.owner)?;
        if self.caveats.hops_left > MAX_DEPTH {
            return Err(ProtocolError::Depth);
        }
        self.interval().map(drop)
    }

    pub fn interval(&self) -> Result<(u64, u64)> {
        let start = self
            .cum_end
            .checked_sub(self.amount)
            .ok_or(ProtocolError::Amount)?;
        Ok((start, self.cum_end))
    }

    pub fn slot(&self) -> Result<[u8; 32]> {
        let (start, end) = self.interval()?;
        Ok(issue_slot(self.lock_seq, start, end))
    }
}

pub fn issue_slot(lock_seq: u32, start: u64, end: u64) -> [u8; 32] {
    let mut out = [0; 32];
    out[..4].copy_from_slice(ISSUE_SLOT_TAG);
    out[4..8].copy_from_slice(&lock_seq.to_le_bytes());
    out[8..16].copy_from_slice(&start.to_le_bytes());
    out[16..24].copy_from_slice(&end.to_le_bytes());
    out
}

impl Signed<Issue> {
    pub fn encode(&self) -> [u8; 227] {
        let mut out = [0; 227];
        out[..163].copy_from_slice(&self.message.body());
        out[163..].copy_from_slice(&self.signature);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != Issue::WIRE_LEN {
            return Err(ProtocolError::Length);
        }
        Ok(Signed {
            message: Issue::decode_body(&bytes[..163])?,
            signature: array(bytes, 163),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outputs {
    One {
        owner: Owner,
        caveats: Caveats,
    },
    Two {
        owner0: Owner,
        amount0: u64,
        caveats0: Caveats,
        owner1: Owner,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spend {
    pub input: [u8; 32],
    pub lock_seq: u32,
    pub salt: [u8; 16],
    pub outputs: Outputs,
}

impl Spend {
    pub const SPEND1_BODY_LEN: usize = 82;
    pub const SPEND2_BODY_LEN: usize = 123;
    pub const SPEND1_WIRE_LEN: usize = 32 + Self::SPEND1_BODY_LEN + 64;
    pub const SPEND2_WIRE_LEN: usize = 32 + Self::SPEND2_BODY_LEN + 64;

    pub fn body(&self, out: &mut [u8; 123]) -> usize {
        out[0] = VERSION;
        out[2..6].copy_from_slice(&self.lock_seq.to_le_bytes());
        out[6..22].copy_from_slice(&self.salt);
        match &self.outputs {
            Outputs::One { owner, caveats } => {
                out[1] = kind::SPEND1;
                out[22..55].copy_from_slice(&owner.encode());
                out[55..82].copy_from_slice(&caveats.encode());
                Self::SPEND1_BODY_LEN
            }
            Outputs::Two {
                owner0,
                amount0,
                caveats0,
                owner1,
            } => {
                out[1] = kind::SPEND2;
                out[22..55].copy_from_slice(&owner0.encode());
                out[55..63].copy_from_slice(&amount0.to_le_bytes());
                out[63..90].copy_from_slice(&caveats0.encode());
                out[90..123].copy_from_slice(&owner1.encode());
                Self::SPEND2_BODY_LEN
            }
        }
    }

    pub fn content(&self) -> [u8; 32] {
        let mut body = [0; Self::SPEND2_BODY_LEN];
        let len = self.body(&mut body);
        hash::content(&body[..len])
    }

    pub fn decode(input: [u8; 32], body: &[u8]) -> Result<Spend> {
        let kind = *body.get(1).ok_or(ProtocolError::Length)?;
        let outputs = match (kind, body.len()) {
            (kind::SPEND1, Self::SPEND1_BODY_LEN) => {
                header(body, kind::SPEND1)?;
                Outputs::One {
                    owner: Owner::decode(&array(body, 22))?,
                    caveats: Caveats::decode(&array(body, 55))?,
                }
            }
            (kind::SPEND2, Self::SPEND2_BODY_LEN) => {
                header(body, kind::SPEND2)?;
                Outputs::Two {
                    owner0: Owner::decode(&array(body, 22))?,
                    amount0: u64_at(body, 55),
                    caveats0: Caveats::decode(&array(body, 63))?,
                    owner1: Owner::decode(&array(body, 90))?,
                }
            }
            (kind::SPEND1 | kind::SPEND2, _) => return Err(ProtocolError::Length),
            _ => {
                header(body, kind::SPEND1)?;
                return Err(ProtocolError::Kind);
            }
        };
        let spend = Spend {
            input,
            lock_seq: u32_at(body, 2),
            salt: array(body, 6),
            outputs,
        };
        spend.check()?;
        Ok(spend)
    }

    pub fn check(&self) -> Result<()> {
        let (owner, caveats) = match &self.outputs {
            Outputs::One { owner, caveats } => (owner, caveats),
            Outputs::Two {
                owner0,
                amount0,
                caveats0,
                ..
            } => {
                if *amount0 == 0 {
                    return Err(ProtocolError::Amount);
                }
                (owner0, caveats0)
            }
        };
        caveats.check()?;
        caveats.check_holder(owner)
    }
}

impl Signed<Spend> {
    pub fn encode(&self, out: &mut [u8; 219]) -> usize {
        let mut body = [0; 123];
        let len = self.message.body(&mut body);
        out[..32].copy_from_slice(&self.message.input);
        out[32..32 + len].copy_from_slice(&body[..len]);
        out[32 + len..32 + len + 64].copy_from_slice(&self.signature);
        32 + len + 64
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != Spend::SPEND1_WIRE_LEN && bytes.len() != Spend::SPEND2_WIRE_LEN {
            return Err(ProtocolError::Length);
        }
        let body_end = bytes.len() - 64;
        Ok(Signed {
            message: Spend::decode(array(bytes, 0), &bytes[32..body_end])?,
            signature: array(bytes, body_end),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BondTicket {
    pub device: [u8; 33],
    pub mint: [u8; 32],
    pub lock_seq: u32,
    pub bond: u64,
    pub backing: u64,
    pub lock_until: u32,
    pub attester: u16,
    pub signature: [u8; 64],
}

impl BondTicket {
    pub const BODY_LEN: usize = 93;
    pub const WIRE_LEN: usize = Self::BODY_LEN + 64;

    fn body(&self) -> [u8; 93] {
        let mut out = [0; 93];
        out[0] = VERSION;
        out[1] = kind::BOND_TICKET;
        out[2..35].copy_from_slice(&self.device);
        out[35..67].copy_from_slice(&self.mint);
        out[67..71].copy_from_slice(&self.lock_seq.to_le_bytes());
        out[71..79].copy_from_slice(&self.bond.to_le_bytes());
        out[79..87].copy_from_slice(&self.backing.to_le_bytes());
        out[87..91].copy_from_slice(&self.lock_until.to_le_bytes());
        out[91..93].copy_from_slice(&self.attester.to_le_bytes());
        out
    }

    pub fn encode(&self) -> [u8; 157] {
        let mut out = [0; 157];
        out[..93].copy_from_slice(&self.body());
        out[93..].copy_from_slice(&self.signature);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<BondTicket> {
        if bytes.len() != Self::WIRE_LEN {
            return Err(ProtocolError::Length);
        }
        header(bytes, kind::BOND_TICKET)?;
        let ticket = BondTicket {
            device: array(bytes, 2),
            mint: array(bytes, 35),
            lock_seq: u32_at(bytes, 67),
            bond: u64_at(bytes, 71),
            backing: u64_at(bytes, 79),
            lock_until: u32_at(bytes, 87),
            attester: u16::from_le_bytes(array(bytes, 91)),
            signature: array(bytes, 93),
        };
        device(&ticket.device)?;
        Ok(ticket)
    }

    /// The bytes the attester signs with Ed25519: the ticket-purpose domain, then the body.
    pub fn signed_message(&self, ticket_domain: &[u8; 32]) -> [u8; 125] {
        let mut out = [0; 125];
        out[..32].copy_from_slice(ticket_domain);
        out[32..].copy_from_slice(&self.body());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{flags, Caveats, ScopeKind};
    use proptest::prelude::*;

    fn caveats() -> Caveats {
        Caveats {
            expiry: 1_900_000_000,
            hops_left: 4,
            flags: 0,
            scope_kind: ScopeKind::Any,
            scope: [0; 20],
        }
    }

    fn device(tag: u8) -> Owner {
        let mut key = [tag; 33];
        key[0] = 0x02;
        Owner::Device(key)
    }

    fn issue() -> Issue {
        Issue {
            issuer: device(1).encode(),
            mint: [3; 32],
            lock_seq: 7,
            cum_end: 50_000,
            salt: [4; 16],
            owner: device(2),
            amount: 20_000,
            caveats: caveats(),
        }
    }

    fn spend2(amount0: u64) -> Spend {
        Spend {
            input: [6; 32],
            lock_seq: 1,
            salt: [8; 16],
            outputs: Outputs::Two {
                owner0: device(3),
                amount0,
                caveats0: caveats(),
                owner1: device(4),
            },
        }
    }

    #[test]
    fn issue_sizes_match_the_spec() {
        assert_eq!(issue().body().len(), Issue::BODY_LEN);
        let signed = Signed {
            message: issue(),
            signature: [5; 64],
        };
        assert_eq!(signed.encode().len(), Issue::WIRE_LEN);
    }

    #[test]
    fn issue_round_trips() {
        let signed = Signed {
            message: issue(),
            signature: [5; 64],
        };
        assert_eq!(Signed::<Issue>::decode(&signed.encode()), Ok(signed));
    }

    #[test]
    fn issue_interval_is_the_claimed_backing() {
        assert_eq!(issue().interval(), Ok((30_000, 50_000)));
        let over = Issue {
            amount: 60_000,
            ..issue()
        };
        assert_eq!(over.interval(), Err(ProtocolError::Amount));
    }

    #[test]
    fn issue_rejects_zero_amount_no_lock_excess_depth_and_account_issuer() {
        let deep = Caveats {
            hops_left: 17,
            ..caveats()
        };
        let cases = [
            (
                Issue {
                    amount: 0,
                    ..issue()
                },
                ProtocolError::Amount,
            ),
            (
                Issue {
                    lock_seq: NO_LOCK,
                    ..issue()
                },
                ProtocolError::Lock,
            ),
            (
                Issue {
                    caveats: deep,
                    ..issue()
                },
                ProtocolError::Depth,
            ),
            (
                Issue {
                    issuer: Owner::Account([1; 32]).encode(),
                    ..issue()
                },
                ProtocolError::Owner,
            ),
        ];
        for (bad, error) in cases {
            assert_eq!(bad.check(), Err(error));
            assert_eq!(Issue::decode_body(&bad.body()), Err(error));
        }
    }

    #[test]
    fn outputs_never_name_a_device_as_their_authority() {
        let authority = Caveats {
            flags: flags::AUTHORITY_ONLY,
            scope_kind: ScopeKind::Authority,
            scope: device(2).scope_hash(),
            ..caveats()
        };
        let to_authority = Issue {
            caveats: authority,
            ..issue()
        };
        assert_eq!(to_authority.check(), Err(ProtocolError::Scope));
        assert_eq!(
            Issue::decode_body(&to_authority.body()),
            Err(ProtocolError::Scope)
        );
        let spend = Spend {
            outputs: Outputs::One {
                owner: device(2),
                caveats: authority,
            },
            ..spend2(5)
        };
        let mut body = [0; 123];
        let len = spend.body(&mut body);
        assert_eq!(spend.check(), Err(ProtocolError::Scope));
        assert_eq!(
            Spend::decode([6; 32], &body[..len]),
            Err(ProtocolError::Scope)
        );
        let to_account = Issue {
            owner: Owner::Account([2; 32]),
            caveats: Caveats {
                scope: Owner::Account([2; 32]).scope_hash(),
                ..authority
            },
            ..issue()
        };
        assert_eq!(to_account.check(), Ok(()));
    }

    #[test]
    fn decoders_reject_wrong_version_and_kind() {
        let mut body = issue().body();
        body[0] = 2;
        assert_eq!(Issue::decode_body(&body), Err(ProtocolError::Version));
        body[0] = 1;
        body[1] = kind::SPEND1;
        assert_eq!(Issue::decode_body(&body), Err(ProtocolError::Kind));
    }

    #[test]
    fn spend_wire_sizes_match_the_spec() {
        let one = Signed {
            message: Spend {
                input: [6; 32],
                lock_seq: 1,
                salt: [8; 16],
                outputs: Outputs::One {
                    owner: device(3),
                    caveats: caveats(),
                },
            },
            signature: [5; 64],
        };
        let two = Signed {
            message: spend2(5),
            signature: [5; 64],
        };
        let mut buf = [0; Spend::SPEND2_WIRE_LEN];
        assert_eq!(one.encode(&mut buf), Spend::SPEND1_WIRE_LEN);
        assert_eq!(
            Signed::<Spend>::decode(&buf[..Spend::SPEND1_WIRE_LEN]),
            Ok(one)
        );
        assert_eq!(two.encode(&mut buf), Spend::SPEND2_WIRE_LEN);
        assert_eq!(Signed::<Spend>::decode(&buf), Ok(two));
    }

    #[test]
    fn spend_content_depends_on_the_salt() {
        let salted = Spend {
            salt: [9; 16],
            ..spend2(5)
        };
        assert_ne!(spend2(5).content(), salted.content());
    }

    #[test]
    fn spend2_rejects_zero_payment() {
        let mut body = [0; 123];
        let len = spend2(0).body(&mut body);
        assert_eq!(spend2(0).check(), Err(ProtocolError::Amount));
        assert_eq!(
            Spend::decode([6; 32], &body[..len]),
            Err(ProtocolError::Amount)
        );
    }

    #[test]
    fn bond_ticket_round_trips_and_signs_domain_then_body() {
        let ticket = BondTicket {
            device: [2; 33],
            mint: [3; 32],
            lock_seq: 3,
            bond: 100,
            backing: 500,
            lock_until: 1_900_000_000,
            attester: 1,
            signature: [9; 64],
        };
        let wire = ticket.encode();
        assert_eq!(wire.len(), BondTicket::WIRE_LEN);
        assert_eq!(BondTicket::decode(&wire), Ok(ticket));
        let message = ticket.signed_message(&[7; 32]);
        assert_eq!(&message[..32], &[7; 32]);
        assert_eq!(&message[32..], &wire[..BondTicket::BODY_LEN]);
    }

    proptest! {
        #[test]
        fn decoders_never_panic_on_arbitrary_bytes(bytes in proptest::collection::vec(any::<u8>(), 0..300)) {
            let _ = Signed::<Issue>::decode(&bytes);
            let _ = Signed::<Spend>::decode(&bytes);
            let _ = BondTicket::decode(&bytes);
        }

        #[test]
        fn issue_round_trips_for_any_fields(
            (cum_end, amount) in (1u64..).prop_flat_map(|cum_end| (Just(cum_end), 1..=cum_end)),
            lock_seq in 0..NO_LOCK,
            salt in any::<[u8; 16]>(),
        ) {
            let message = Issue { cum_end, amount, lock_seq, salt, ..issue() };
            let signed = Signed { message, signature: [5; 64] };
            prop_assert_eq!(Signed::<Issue>::decode(&signed.encode()), Ok(signed));
        }
    }
}
