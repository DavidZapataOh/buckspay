//! The public inputs of every message of a chain, rebuilt from what travels on the wire.

use buckspay_protocol::hash::{envelope, message_id, output_id};

use crate::{fr, Public, VerifyError, NUM_PUBLIC};

/// What the wire carries for one message besides its proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessagePublic {
    pub content: [u8; 32],
    /// Which output of this message the next one consumes; zero for the last message.
    pub next_bit: u8,
    /// The commitment to the state this message leaves; zero for the last message.
    pub s_out: [u8; 32],
}

/// What the whole chain says: the issue and the final payment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainContext {
    pub domain: [u8; 32],
    pub issuer_key: [u8; 33],
    pub mint: [u8; 32],
    pub lock_seq: u32,
    pub amount: u64,
    pub cum_end: u64,
    pub payee: [u8; 32],
    pub pay_amount: u64,
    pub expiry: u32,
}

const CTRL_ISSUE: u8 = 1;
const CTRL_LAST: u8 = 2;
const CTRL_NEXT: u8 = 4;

/// The slot of the issue: its lock sequence and the interval of the lock it draws.
fn issue_slot(ctx: &ChainContext) -> Result<[u8; 32], VerifyError> {
    let start = ctx
        .cum_end
        .checked_sub(ctx.amount)
        .ok_or(VerifyError::Input)?;
    let mut slot = [0u8; 32];
    slot[..4].copy_from_slice(b"ISSU");
    slot[4..8].copy_from_slice(&ctx.lock_seq.to_le_bytes());
    slot[8..16].copy_from_slice(&start.to_le_bytes());
    slot[16..24].copy_from_slice(&ctx.cum_end.to_le_bytes());
    Ok(slot)
}

fn check(msgs: &[MessagePublic]) -> Result<(), VerifyError> {
    let Some((last, rest)) = msgs.split_last() else {
        return Err(VerifyError::Empty);
    };
    if last.next_bit != 0 || last.s_out != [0; 32] || rest.iter().any(|m| m.next_bit > 1) {
        return Err(VerifyError::Input);
    }
    if !rest.iter().all(|m| fr::is_canonical(&m.s_out)) {
        return Err(VerifyError::NonCanonical);
    }
    Ok(())
}

/// The slot and the id of every message.
struct Ids {
    /// The issue slot, then the output each spend consumed.
    slots: Vec<[u8; 32]>,
    ids: Vec<[u8; 32]>,
}

fn ids(ctx: &ChainContext, msgs: &[MessagePublic]) -> Result<Ids, VerifyError> {
    check(msgs)?;
    let mut slots = Vec::with_capacity(msgs.len());
    let mut ids = Vec::with_capacity(msgs.len());
    let mut slot = issue_slot(ctx)?;
    for m in msgs {
        slots.push(slot);
        let id = message_id(&envelope(&ctx.domain, &slot, &m.content));
        slot = output_id(&id, m.next_bit);
        ids.push(id);
    }
    Ok(Ids { slots, ids })
}

fn word(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

/// The public inputs of every message, in the order of the circuit: `e_hi e_lo ctrl s_in s_out
/// a_hi a_lo b_hi b_lo amt`.
pub fn public_inputs(
    ctx: &ChainContext,
    msgs: &[MessagePublic],
) -> Result<Vec<Public>, VerifyError> {
    let Ids { ids, .. } = ids(ctx, msgs)?;
    let mut out = Vec::with_capacity(msgs.len());
    for (i, (m, id)) in msgs.iter().zip(&ids).enumerate() {
        let is_issue = i == 0;
        let is_last = !is_issue && i + 1 == msgs.len();
        let mut p: Public = [[0u8; 32]; NUM_PUBLIC];
        p[0] = word(&id[..16]);
        p[1] = word(&id[16..]);
        p[2] = word(&[if is_issue { CTRL_ISSUE } else { 0 }
            | if is_last { CTRL_LAST } else { 0 }
            | if m.next_bit == 1 { CTRL_NEXT } else { 0 }]);
        if !is_issue {
            p[3] = msgs[i - 1].s_out;
        }
        p[4] = m.s_out;
        if is_issue {
            p[5] = word(&ctx.issuer_key[..17]);
            p[6] = word(&ctx.issuer_key[17..]);
            p[7] = word(&ctx.mint[..16]);
            p[8] = word(&ctx.mint[16..]);
            p[9] = word(&((u128::from(ctx.amount) << 32) | u128::from(ctx.lock_seq)).to_be_bytes());
        } else if is_last {
            p[5] = word(&ctx.payee[..16]);
            p[6] = word(&ctx.payee[16..]);
            p[9] =
                word(&((u128::from(ctx.pay_amount) << 32) | u128::from(ctx.expiry)).to_be_bytes());
        }
        out.push(p);
    }
    Ok(out)
}

/// The output each spend consumes, in chain order: what the program records for the settlement.
pub fn consumed_outputs(
    ctx: &ChainContext,
    msgs: &[MessagePublic],
) -> Result<Vec<[u8; 32]>, VerifyError> {
    let Ids { slots, .. } = ids(ctx, msgs)?;
    Ok(slots[1..].to_vec())
}
