//! The rules of a chain of messages without any signature check. `verify` adds P-256 verification
//! for off-chain use; the program takes the signatures from the secp256r1 precompile instead.
use crate::{
    caveats::{flags, Caveats, Owner},
    hash::{content, envelope, message_id, output_id},
    lock::EXPIRY_STEP,
    message::{Issue, Outputs, Spend, NO_LOCK},
    ProtocolError, Result,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Output {
    pub id: [u8; 32],
    pub owner: Owner,
    pub amount: u64,
    pub caveats: Caveats,
}

/// The outputs one message creates: output 0 (the payment) and the change of a `Spend2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Holding {
    pub first: Output,
    pub second: Option<Output>,
}

/// Whether a spend of an output with these caveats is backed without the spender's lock.
pub fn unlocked(input: &Caveats) -> bool {
    input.flags & (flags::DELEGATED | flags::AUTHORITY_ONLY) != 0
}

/// A `Spend1` to a terminal account: a settlement, which nothing spends further.
pub fn settles(spend: &Spend) -> bool {
    matches!(
        spend.outputs,
        Outputs::One {
            owner: Owner::Account(_),
            ..
        }
    )
}

/// An output a device holds can be reclaimed by that device, so the spender's own reclaim of the
/// input it paid with must open after the payee's: a payment to a device expires at least
/// `EXPIRY_STEP` before its input. Outputs to terminal accounts are never reclaimed and are free.
pub fn steps_down(input: &Caveats, owner: &Owner, payment: &Caveats) -> bool {
    matches!(owner, Owner::Account(_))
        || u64::from(payment.expiry) + u64::from(EXPIRY_STEP) <= u64::from(input.expiry)
}

fn check_lock(input: &Caveats, spend: &Spend, payment: &Caveats) -> Result<()> {
    if spend.lock_seq != NO_LOCK {
        return Ok(());
    }
    if !(unlocked(input) || settles(spend)) || payment.flags & flags::DELEGATED != 0 {
        return Err(ProtocolError::Lock);
    }
    Ok(())
}

/// The first output (owner, amount, caveats) and the change of a spend of `input`, if the rules of
/// a hop allow them.
pub type Hop = (Owner, u64, Caveats, Option<(u64, Caveats)>);

pub fn hop(input: &Output, spend: &Spend) -> Result<Hop> {
    let (owner, amount, caveats, change) = match spend.outputs {
        Outputs::One { owner, caveats } => (owner, input.amount, caveats, None),
        Outputs::Two {
            owner0,
            amount0,
            caveats0,
            owner1,
        } => {
            let change = input.caveats.change()?;
            if amount0 >= input.amount {
                return Err(ProtocolError::Amount);
            }
            if owner1 != input.owner {
                return Err(ProtocolError::Change);
            }
            (
                owner0,
                amount0,
                caveats0,
                Some((input.amount - amount0, change)),
            )
        }
    };
    let rules = input.caveats.for_holder(&input.owner);
    if !rules.permits(&caveats) {
        return Err(ProtocolError::Attenuation);
    }
    if !steps_down(&input.caveats, &owner, &caveats) {
        return Err(ProtocolError::ExpiryStep);
    }
    if !rules.admits(&owner) {
        return Err(ProtocolError::Scope);
    }
    check_lock(&rules, spend, &caveats)?;
    Ok((owner, amount, caveats, change))
}

/// The envelope the issuer signs and the output the issue creates.
pub fn issue_signing(domain: &[u8; 32], issue: &Issue) -> Result<([u8; 96], Output)> {
    issue.check()?;
    let env = envelope(domain, &issue.slot()?, &content(&issue.body()));
    let output = Output {
        id: output_id(&message_id(&env), 0),
        owner: issue.owner,
        amount: issue.amount,
        caveats: issue.caveats,
    };
    Ok((env, output))
}

/// The key that must sign a spend of `input` and the envelope it signs.
pub fn spend_signing(
    domain: &[u8; 32],
    input: &Output,
    spend: &Spend,
) -> Result<([u8; 33], [u8; 96])> {
    let Owner::Device(holder) = input.owner else {
        return Err(ProtocolError::Owner);
    };
    spend.check()?;
    Ok((holder, envelope(domain, &input.id, &spend.content())))
}

/// The outputs a spend of `input` creates once its envelope `env` is signed, and the owner of the
/// first one.
pub fn spend_outputs(env: &[u8; 96], input: &Output, spend: &Spend) -> Result<(Holding, Owner)> {
    let (owner, amount, caveats, change) = hop(input, spend)?;
    let id = message_id(env);
    Ok((
        Holding {
            first: Output {
                id: output_id(&id, 0),
                owner,
                amount,
                caveats,
            },
            second: change.map(|(amount, caveats)| Output {
                id: output_id(&id, 1),
                owner: input.owner,
                amount,
                caveats,
            }),
        },
        owner,
    ))
}
