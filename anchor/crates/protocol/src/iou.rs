//! Tab states: co-signed changes to what two people owe each other, and the join of a netting
//! session. A state is a change of at least one unit, never a balance: the balance of a tab is the
//! sum of its co-signed changes, so a state signed by both people is evidence of exactly that change.

use crate::message::{array, header, u32_at, u64_at};
use crate::{hash, kind, ProtocolError, Result, VERSION};
use solana_sha256_hasher::hashv;

/// Why a state exists. `OPEN` adds to what the debtor owes, `REPAY` subtracts once the payment it
/// names settled to the creditor, `OUTSIDE` subtracts a settlement made outside the app.
pub mod cause {
    pub const OPEN: u8 = 1;
    pub const REPAY: u8 = 2;
    /// Reserved: a netting is recorded on chain and never signed as a state.
    pub const NETTING: u8 = 3;
    pub const OUTSIDE: u8 = 4;
}

pub const IOU_SLOT_TAG: &[u8; 4] = b"IOUS";
pub const JOIN_SLOT_TAG: &[u8; 4] = b"NETJ";

fn compressed(key: &[u8; 33]) -> Result<()> {
    match key[0] {
        0x02 | 0x03 => Ok(()),
        _ => Err(ProtocolError::Owner),
    }
}

/// One change of a tab, as signed by both parties.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Iou {
    pub tab: [u8; 32],
    pub seq: u32,
    pub debtor: [u8; 33],
    pub creditor: [u8; 33],
    pub mint: [u8; 32],
    /// The size of the change, at least 1.
    pub amount: u64,
    /// Unix seconds, 0 for on demand.
    pub due: u32,
    pub cause: u8,
    /// A `REPAY` names the message id of its payment. `OPEN` and `OUTSIDE` name the content of the
    /// proposer's latest co-signed state, zero for the first change of a tab.
    pub reference: [u8; 32],
    pub memo: [u8; 32],
}

impl Iou {
    pub const BODY_LEN: usize = 213;

    /// The wire body. It does not check the fields: callers that build states call [`Iou::check`].
    pub fn body(&self) -> [u8; 213] {
        let mut out = [0; 213];
        out[0] = VERSION;
        out[1] = kind::IOU;
        out[2..34].copy_from_slice(&self.tab);
        out[34..38].copy_from_slice(&self.seq.to_le_bytes());
        out[38..71].copy_from_slice(&self.debtor);
        out[71..104].copy_from_slice(&self.creditor);
        out[104..136].copy_from_slice(&self.mint);
        out[136..144].copy_from_slice(&self.amount.to_le_bytes());
        out[144..148].copy_from_slice(&self.due.to_le_bytes());
        out[148] = self.cause;
        out[149..181].copy_from_slice(&self.reference);
        out[181..].copy_from_slice(&self.memo);
        out
    }

    pub fn decode_body(bytes: &[u8]) -> Result<Iou> {
        if bytes.len() != Self::BODY_LEN {
            return Err(ProtocolError::Length);
        }
        header(bytes, kind::IOU)?;
        let iou = Iou {
            tab: array(bytes, 2),
            seq: u32_at(bytes, 34),
            debtor: array(bytes, 38),
            creditor: array(bytes, 71),
            mint: array(bytes, 104),
            amount: u64_at(bytes, 136),
            due: u32_at(bytes, 144),
            cause: bytes[148],
            reference: array(bytes, 149),
            memo: array(bytes, 181),
        };
        iou.check()?;
        Ok(iou)
    }

    /// The rules every state obeys, in the order a verifier applies them. Curve validity of the
    /// keys is checked where the signatures are.
    pub fn check(&self) -> Result<()> {
        if self.seq == 0 {
            return Err(ProtocolError::Linkage);
        }
        compressed(&self.debtor)?;
        compressed(&self.creditor)?;
        if self.debtor == self.creditor {
            return Err(ProtocolError::Owner);
        }
        match self.cause {
            cause::OPEN | cause::OUTSIDE => {}
            cause::REPAY if self.reference != [0; 32] => {}
            _ => return Err(ProtocolError::Kind),
        }
        if self.amount == 0 {
            return Err(ProtocolError::Amount);
        }
        Ok(())
    }

    /// Whether this state can come after `previous` in one tab: same tab and mint, the same two
    /// parties in either direction, and a higher `seq` (gaps are allowed).
    pub fn follows(&self, previous: &Iou) -> Result<()> {
        let same_pair = (self.debtor == previous.debtor && self.creditor == previous.creditor)
            || (self.debtor == previous.creditor && self.creditor == previous.debtor);
        if self.tab != previous.tab
            || self.seq <= previous.seq
            || self.mint != previous.mint
            || !same_pair
        {
            return Err(ProtocolError::Linkage);
        }
        Ok(())
    }

    /// The place this state signs for: one per `(tab, seq)`.
    pub fn slot(&self) -> [u8; 32] {
        hashv(&[IOU_SLOT_TAG, &self.tab, &self.seq.to_le_bytes()]).to_bytes()
    }

    pub fn envelope(&self, iou_domain: &[u8; 32]) -> [u8; 96] {
        hash::envelope(iou_domain, &self.slot(), &hash::content(&self.body()))
    }
}

/// A state with both signatures, `body ‖ debtor_sig ‖ creditor_sig`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoSigned {
    pub iou: Iou,
    pub debtor_sig: [u8; 64],
    pub creditor_sig: [u8; 64],
}

impl CoSigned {
    pub const WIRE_LEN: usize = 341;

    pub fn encode(&self) -> [u8; 341] {
        let mut out = [0; 341];
        out[..213].copy_from_slice(&self.iou.body());
        out[213..277].copy_from_slice(&self.debtor_sig);
        out[277..].copy_from_slice(&self.creditor_sig);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != Self::WIRE_LEN {
            return Err(ProtocolError::Length);
        }
        Ok(CoSigned {
            iou: Iou::decode_body(&bytes[..213])?,
            debtor_sig: array(bytes, 213),
            creditor_sig: array(bytes, 277),
        })
    }
}

/// Checks the state, then the signature of each party over its envelope under `iou_domain`.
#[cfg(feature = "verify")]
pub fn verify_co_signed(iou_domain: &[u8; 32], state: &CoSigned) -> Result<()> {
    state.iou.check()?;
    let message = state.iou.envelope(iou_domain);
    crate::verify::verify_signature(&state.iou.debtor, &message, &state.debtor_sig)?;
    crate::verify::verify_signature(&state.iou.creditor, &message, &state.creditor_sig)
}

/// A device's entry into a netting session: the Ed25519 key it will sign the statement with,
/// signed by its device key. One join per device and session, for good.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NettingJoin {
    pub session: [u8; 32],
    pub ephemeral: [u8; 32],
    pub key: [u8; 33],
}

impl NettingJoin {
    pub const BODY_LEN: usize = 99;

    pub fn body(&self) -> [u8; 99] {
        let mut out = [0; 99];
        out[0] = VERSION;
        out[1] = kind::NETTING_JOIN;
        out[2..34].copy_from_slice(&self.session);
        out[34..66].copy_from_slice(&self.ephemeral);
        out[66..].copy_from_slice(&self.key);
        out
    }

    pub fn decode_body(b: &[u8]) -> Result<Self> {
        if b.len() != Self::BODY_LEN {
            return Err(ProtocolError::Length);
        }
        header(b, kind::NETTING_JOIN)?;
        let join = NettingJoin {
            session: array(b, 2),
            ephemeral: array(b, 34),
            key: array(b, 66),
        };
        compressed(&join.key)?;
        Ok(join)
    }

    pub fn slot(&self) -> [u8; 32] {
        hashv(&[JOIN_SLOT_TAG, &self.session]).to_bytes()
    }
}
