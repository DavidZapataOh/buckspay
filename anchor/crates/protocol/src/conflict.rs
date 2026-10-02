use crate::message::{array, issue_slot, kind};
use crate::{hash, ProtocolError, Result, VERSION};

fn check_header(bytes: &[u8], len: usize, expected_kind: u8) -> Result<u8> {
    if bytes.len() != len {
        return Err(ProtocolError::Length);
    }
    if bytes[0] != VERSION {
        return Err(ProtocolError::Version);
    }
    if bytes[1] != expected_kind {
        return Err(ProtocolError::Kind);
    }
    let recovery = bytes[len - 1];
    if recovery > 0x0f {
        return Err(ProtocolError::Signature);
    }
    Ok(recovery)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpendConflict {
    pub slot: [u8; 32],
    pub content_a: [u8; 32],
    pub signature_a: [u8; 64],
    pub content_b: [u8; 32],
    pub signature_b: [u8; 64],
    /// Recovery ids of both signatures: `a | b << 2`.
    pub recovery: u8,
}

impl SpendConflict {
    pub const WIRE_LEN: usize = 227;

    pub fn encode(&self) -> [u8; 227] {
        let mut out = [0; 227];
        out[0] = VERSION;
        out[1] = kind::SPEND_CONFLICT;
        out[2..34].copy_from_slice(&self.slot);
        out[34..66].copy_from_slice(&self.content_a);
        out[66..130].copy_from_slice(&self.signature_a);
        out[130..162].copy_from_slice(&self.content_b);
        out[162..226].copy_from_slice(&self.signature_b);
        out[226] = self.recovery;
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<SpendConflict> {
        let recovery = check_header(bytes, Self::WIRE_LEN, kind::SPEND_CONFLICT)?;
        Ok(SpendConflict {
            slot: array(bytes, 2),
            content_a: array(bytes, 34),
            signature_a: array(bytes, 66),
            content_b: array(bytes, 130),
            signature_b: array(bytes, 162),
            recovery,
        })
    }

    pub fn is_equivocation(&self) -> bool {
        self.content_a != self.content_b
    }

    pub fn envelopes(&self, domain: &[u8; 32]) -> ([u8; 96], [u8; 96]) {
        (
            hash::envelope(domain, &self.slot, &self.content_a),
            hash::envelope(domain, &self.slot, &self.content_b),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssueClaim {
    pub lock_seq: u32,
    pub start: u64,
    pub end: u64,
    pub content: [u8; 32],
    pub signature: [u8; 64],
}

impl IssueClaim {
    const LEN: usize = 116;

    fn write(&self, out: &mut [u8]) {
        out[..4].copy_from_slice(&self.lock_seq.to_le_bytes());
        out[4..12].copy_from_slice(&self.start.to_le_bytes());
        out[12..20].copy_from_slice(&self.end.to_le_bytes());
        out[20..52].copy_from_slice(&self.content);
        out[52..116].copy_from_slice(&self.signature);
    }

    fn read(bytes: &[u8]) -> IssueClaim {
        IssueClaim {
            lock_seq: u32::from_le_bytes(array(bytes, 0)),
            start: u64::from_le_bytes(array(bytes, 4)),
            end: u64::from_le_bytes(array(bytes, 12)),
            content: array(bytes, 20),
            signature: array(bytes, 52),
        }
    }

    fn envelope(&self, domain: &[u8; 32]) -> [u8; 96] {
        hash::envelope(
            domain,
            &issue_slot(self.lock_seq, self.start, self.end),
            &self.content,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssueConflict {
    pub a: IssueClaim,
    pub b: IssueClaim,
    /// Recovery ids of both signatures: `a | b << 2`.
    pub recovery: u8,
}

impl IssueConflict {
    pub const WIRE_LEN: usize = 3 + 2 * IssueClaim::LEN;

    pub fn encode(&self) -> [u8; 235] {
        let mut out = [0; 235];
        out[0] = VERSION;
        out[1] = kind::ISSUE_CONFLICT;
        self.a.write(&mut out[2..118]);
        self.b.write(&mut out[118..234]);
        out[234] = self.recovery;
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<IssueConflict> {
        let recovery = check_header(bytes, Self::WIRE_LEN, kind::ISSUE_CONFLICT)?;
        Ok(IssueConflict {
            a: IssueClaim::read(&bytes[2..118]),
            b: IssueClaim::read(&bytes[118..234]),
            recovery,
        })
    }

    pub fn is_over_issuance(&self) -> bool {
        self.a.lock_seq == self.b.lock_seq
            && self.a.content != self.b.content
            && self.a.start < self.a.end
            && self.b.start < self.b.end
            && self.a.start < self.b.end
            && self.b.start < self.a.end
    }

    pub fn envelopes(&self, domain: &[u8; 32]) -> ([u8; 96], [u8; 96]) {
        (self.a.envelope(domain), self.b.envelope(domain))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(start: u64, end: u64, content: u8) -> IssueClaim {
        IssueClaim {
            lock_seq: 1,
            start,
            end,
            content: [content; 32],
            signature: [7; 64],
        }
    }

    fn spend_conflict(content_b: u8) -> SpendConflict {
        SpendConflict {
            slot: [1; 32],
            content_a: [2; 32],
            signature_a: [3; 64],
            content_b: [content_b; 32],
            signature_b: [5; 64],
            recovery: 0b0110,
        }
    }

    fn issue_conflict(a: IssueClaim, b: IssueClaim) -> IssueConflict {
        IssueConflict { a, b, recovery: 0 }
    }

    #[test]
    fn spend_conflict_round_trips_at_227_bytes() {
        let conflict = spend_conflict(4);
        let bytes = conflict.encode();
        assert_eq!(bytes.len(), SpendConflict::WIRE_LEN);
        assert_eq!(SpendConflict::decode(&bytes), Ok(conflict));
    }

    #[test]
    fn decoders_reject_unknown_recovery_bits() {
        let mut spend = spend_conflict(4).encode();
        spend[226] = 0x10;
        assert_eq!(SpendConflict::decode(&spend), Err(ProtocolError::Signature));
        let mut issue = issue_conflict(claim(0, 100, 1), claim(50, 150, 2)).encode();
        issue[234] = 0x10;
        assert_eq!(IssueConflict::decode(&issue), Err(ProtocolError::Signature));
    }

    #[test]
    fn same_content_is_not_equivocation() {
        assert!(!spend_conflict(2).is_equivocation());
    }

    #[test]
    fn overlapping_issues_are_over_issuance() {
        let conflict = issue_conflict(claim(0, 100, 1), claim(50, 150, 2));
        assert_eq!(conflict.encode().len(), IssueConflict::WIRE_LEN);
        assert_eq!(IssueConflict::decode(&conflict.encode()), Ok(conflict));
        assert!(conflict.is_over_issuance());
    }

    #[test]
    fn adjacent_or_identical_issues_are_not_over_issuance() {
        assert!(!issue_conflict(claim(0, 100, 1), claim(100, 200, 2)).is_over_issuance());
        assert!(!issue_conflict(claim(0, 100, 1), claim(0, 100, 1)).is_over_issuance());
        let other_lock = IssueClaim {
            lock_seq: 2,
            ..claim(0, 100, 2)
        };
        assert!(!issue_conflict(claim(0, 100, 1), other_lock).is_over_issuance());
    }
}
