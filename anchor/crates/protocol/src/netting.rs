//! The statement a circle of people signs to cancel their debts at once.

use crate::message::{array, header, u32_at, u64_at};
use crate::{hash, kind, ProtocolError, Result, VERSION};
use solana_sha256_hasher::hashv;

pub const MAX_PARTICIPANTS: usize = 8;
pub const NETTING_PUBLIC: usize = 4;
pub const STATEMENT_BASE_LEN: usize = 111;
pub const SESSION_FIELD_TAG: &[u8] = b"BUCKSPAY:v1:netting-session";

/// The BN254 scalar field order r, big-endian.
pub const BN254_R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NettingStatement {
    pub session: [u8; 32],
    pub mint: [u8; 32],
    pub participants: u8,
    pub total: u64,
    pub expires: u32,
    /// Big-endian, below [`BN254_R`].
    pub root: [u8; 32],
    /// The first `participants` entries are the Ed25519 keys, the rest are zero.
    pub ephemeral: [[u8; 32]; MAX_PARTICIPANTS],
}

fn be32(value: u64) -> [u8; 32] {
    let mut out = [0; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

impl NettingStatement {
    pub fn body_len(participants: u8) -> usize {
        STATEMENT_BASE_LEN + 32 * usize::from(participants)
    }

    /// Writes the body into `out` and returns its length. Callers check the statement first.
    pub fn encode(&self, out: &mut [u8; STATEMENT_BASE_LEN + 32 * MAX_PARTICIPANTS]) -> usize {
        out[0] = VERSION;
        out[1] = kind::NETTING;
        out[2..34].copy_from_slice(&self.session);
        out[34..66].copy_from_slice(&self.mint);
        out[66] = self.participants;
        out[67..75].copy_from_slice(&self.total.to_le_bytes());
        out[75..79].copy_from_slice(&self.expires.to_le_bytes());
        out[79..111].copy_from_slice(&self.root);
        let n = usize::from(self.participants).min(MAX_PARTICIPANTS);
        for (i, key) in self.ephemeral.iter().take(n).enumerate() {
            out[111 + 32 * i..143 + 32 * i].copy_from_slice(key);
        }
        STATEMENT_BASE_LEN + 32 * n
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 67 {
            return Err(ProtocolError::Length);
        }
        header(bytes, kind::NETTING)?;
        let n = bytes[66];
        if !(2..=MAX_PARTICIPANTS as u8).contains(&n) || bytes.len() != Self::body_len(n) {
            return Err(ProtocolError::Length);
        }
        let mut ephemeral = [[0; 32]; MAX_PARTICIPANTS];
        for (i, key) in ephemeral.iter_mut().take(usize::from(n)).enumerate() {
            *key = array(bytes, 111 + 32 * i);
        }
        let statement = NettingStatement {
            session: array(bytes, 2),
            mint: array(bytes, 34),
            participants: n,
            total: u64_at(bytes, 67),
            expires: u32_at(bytes, 75),
            root: array(bytes, 79),
            ephemeral,
        };
        statement.check()?;
        Ok(statement)
    }

    pub fn check(&self) -> Result<()> {
        let n = usize::from(self.participants);
        if !(2..=MAX_PARTICIPANTS).contains(&n) {
            return Err(ProtocolError::Length);
        }
        if self.ephemeral[n..].iter().any(|key| *key != [0; 32]) {
            return Err(ProtocolError::Length);
        }
        let keys = &self.ephemeral[..n];
        if keys
            .iter()
            .enumerate()
            .any(|(i, key)| keys[..i].contains(key))
        {
            return Err(ProtocolError::Signer);
        }
        if self.root >= BN254_R {
            return Err(ProtocolError::Amount);
        }
        Ok(())
    }

    pub fn content(&self) -> [u8; 32] {
        let mut body = [0; STATEMENT_BASE_LEN + 32 * MAX_PARTICIPANTS];
        let len = self.encode(&mut body);
        hash::content(&body[..len])
    }

    /// `netting_domain ‖ session ‖ content`: the message every participant signs.
    pub fn envelope(&self, netting_domain: &[u8; 32]) -> [u8; 96] {
        hash::envelope(netting_domain, &self.session, &self.content())
    }

    /// `[session_field, n, total, root]`, each 32 bytes big-endian, as the circuit reads them.
    pub fn public_inputs(&self) -> [[u8; 32]; NETTING_PUBLIC] {
        [
            session_field(self),
            be32(u64::from(self.participants)),
            be32(self.total),
            self.root,
        ]
    }
}

/// What a proof binds to: `SHA-256(tag ‖ session ‖ mint ‖ expires ‖ n ‖ keys)` with the top three
/// bits cleared so it is a field element. A proof published for one statement records no other.
pub fn session_field(statement: &NettingStatement) -> [u8; 32] {
    let n = usize::from(statement.participants).min(MAX_PARTICIPANTS);
    let mut keys = [0; 32 * MAX_PARTICIPANTS];
    for (i, key) in statement.ephemeral.iter().take(n).enumerate() {
        keys[32 * i..32 * i + 32].copy_from_slice(key);
    }
    let mut out = hashv(&[
        SESSION_FIELD_TAG,
        &statement.session,
        &statement.mint,
        &statement.expires.to_le_bytes(),
        &[statement.participants],
        &keys[..32 * n],
    ])
    .to_bytes();
    out[0] &= 0x1f;
    out
}
