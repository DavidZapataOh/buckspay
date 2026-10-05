//! Walking a chain of messages: the rules of the protocol, the keys and envelopes the precompile
//! must have verified, the outputs each spend consumed and the records presented for them.
use anchor_lang::prelude::*;
use buckspay_protocol::{
    chain::{self, Holding, Output},
    hash::content,
    secp256r1::Expected,
    window, Issue, ProtocolError, Spend,
};

use crate::{
    error::BuckspayError,
    records::Role,
    spent::{self, Slot},
};

pub const ISSUE_BODY_LEN: usize = Issue::BODY_LEN;

/// One spend of the chain: which output of the previous message it consumes (0 is the payment,
/// 1 the change) and its body. Its signature and slot travel in the precompile instruction.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Link {
    pub input: u8,
    pub body: Vec<u8>,
}

/// An output a spend of the chain consumed.
pub struct Consumed {
    pub output: [u8; 32],
    pub content: [u8; 32],
    pub expiry: u32,
}

pub struct Walk {
    pub issue: Issue,
    /// The key and envelope each message must have been signed with, issue first.
    pub entries: Vec<Expected>,
    pub consumed: Vec<Consumed>,
    /// The outputs of the last message (the issue's output when there are no spends).
    pub last: Holding,
}

/// A message presented to the record of the output it consumed.
pub struct Presented {
    pub output: [u8; 32],
    pub content: [u8; 32],
    pub expiry: u32,
    pub role: Role,
    /// The index in `Walk::entries` of the message whose content the record holds, if the record
    /// can vouch for a message at all (a reclaim's record cannot).
    pub message: Option<usize>,
}

fn invalid(error: ProtocolError) -> Error {
    msg!("chain: {:?}", error);
    error!(BuckspayError::ChainInvalid)
}

pub fn walk(domain: &[u8; 32], issue_body: &[u8; ISSUE_BODY_LEN], links: &[Link]) -> Result<Walk> {
    let issue = Issue::decode_body(issue_body).map_err(invalid)?;
    let (envelope, output) = chain::issue_signing(domain, &issue).map_err(invalid)?;
    let mut entries = Vec::with_capacity(links.len() + 2);
    entries.push((issue.issuer, envelope));
    let mut last = Holding {
        first: output,
        second: None,
    };
    let mut consumed = Vec::with_capacity(links.len());
    for link in links {
        let input: Output = match link.input {
            0 => last.first,
            1 => last
                .second
                .ok_or_else(|| error!(BuckspayError::ChainInvalid))?,
            _ => return Err(error!(BuckspayError::ChainInvalid)),
        };
        let spend = Spend::decode(input.id, &link.body).map_err(invalid)?;
        let (holder, envelope) = chain::spend_signing(domain, &input, &spend).map_err(invalid)?;
        let (next, _) = chain::spend_outputs(&envelope, &input, &spend).map_err(invalid)?;
        entries.push((holder, envelope));
        consumed.push(Consumed {
            output: input.id,
            content: content(&link.body),
            expiry: input.caveats.expiry,
        });
        last = next;
    }
    Ok(Walk {
        issue,
        entries,
        consumed,
        last,
    })
}

impl Walk {
    /// Every consumed output with the spend that consumed it, in chain order, as a prefix.
    pub fn prefixes(&self) -> Vec<Presented> {
        self.consumed
            .iter()
            .enumerate()
            .map(|(i, c)| Presented {
                output: c.output,
                content: c.content,
                expiry: c.expiry,
                role: Role::Prefix,
                message: Some(i + 1),
            })
            .collect()
    }

    /// The records of a settlement: the prefixes, the last of them paid; with no spend, the
    /// issue's own output, paid.
    pub fn settlement(&self, issue_body: &[u8; ISSUE_BODY_LEN]) -> Vec<Presented> {
        let mut presented = self.prefixes();
        match presented.last_mut() {
            Some(last) => last.role = Role::Final,
            None => presented.push(Presented {
                output: self.last.first.id,
                content: content(issue_body),
                expiry: self.issue.caveats.expiry,
                role: Role::Final,
                message: Some(0),
            }),
        }
        presented
    }
}

/// Checks the record accounts one by one and reads them.
pub fn load_slots(presented: &[Presented], records: &[AccountInfo]) -> Result<Vec<Slot>> {
    require_eq!(
        presented.len(),
        records.len(),
        BuckspayError::RecordAccounts
    );
    presented
        .iter()
        .zip(records)
        .map(|(p, account)| spent::load(account, &p.output))
        .collect()
}

/// The index of the first message of the chain whose signature the transaction must carry.
///
/// A record of an output with the content of the message that consumed it is written only after
/// that message, the one that created the output and everything before them were verified, and
/// the output id commits to all of them: it is the hash of the envelope of the message that
/// created it, which holds the hash of its body and the id of its own input. A chain whose record
/// is there, with the same content, therefore needs the signatures of the later messages only.
pub fn first_unverified(presented: &[Presented], slots: &[Slot]) -> usize {
    presented
        .iter()
        .zip(slots)
        .filter_map(|(p, slot)| match (p.message, slot.record) {
            (Some(message), Some(record)) if record.content == p.content => Some(message + 1),
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

/// Presents every message to its record. Returns whether the last one is to be paid.
pub fn present<'info>(
    presented: &[Presented],
    slots: Vec<Slot>,
    records: &[AccountInfo<'info>],
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    lock_until: u32,
) -> Result<bool> {
    let mut pay = false;
    for ((p, slot), account) in presented.iter().zip(slots).zip(records) {
        let closable_at = u32::try_from(window::closable_at(p.expiry, lock_until))
            .map_err(|_| error!(BuckspayError::ClockOutOfRange))?;
        pay = spent::apply(slot, account, p, closable_at, payer, system_program)?;
    }
    Ok(pay)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{Record, PAID, RECLAIMED};
    use buckspay_protocol::reclaim::record_content;
    use proptest::prelude::*;

    fn item(message: usize, byte: u8) -> Presented {
        Presented {
            output: [message as u8; 32],
            content: [byte; 32],
            expiry: 0,
            role: Role::Prefix,
            message: Some(message),
        }
    }

    fn stored(byte: u8) -> Slot {
        Slot::with(Some(Record {
            content: [byte; 32],
            flags: 0,
        }))
    }

    #[test]
    fn nothing_recorded_verifies_everything() {
        let items = [item(1, 1), item(2, 2)];
        assert_eq!(
            first_unverified(&items, &[Slot::with(None), Slot::with(None)]),
            0
        );
    }

    #[test]
    fn a_matching_record_vouches_for_everything_up_to_its_message() {
        let items = [item(1, 1), item(2, 2), item(3, 3)];
        let slots = [stored(1), Slot::with(None), Slot::with(None)];
        assert_eq!(first_unverified(&items, &slots), 2);
        let slots = [stored(1), stored(2), Slot::with(None)];
        assert_eq!(first_unverified(&items, &slots), 3);
    }

    #[test]
    fn a_record_of_another_content_vouches_for_nothing() {
        let items = [item(1, 1), item(2, 2)];
        assert_eq!(first_unverified(&items, &[stored(9), stored(8)]), 0);
    }

    #[test]
    fn a_reclaim_record_vouches_for_nothing() {
        let items = [item(1, 1)];
        let reclaimed = Slot::with(Some(Record {
            content: record_content(),
            flags: PAID | RECLAIMED,
        }));
        assert_eq!(first_unverified(&items, &[reclaimed]), 0);
    }

    #[test]
    fn a_settled_issue_vouches_for_the_issue() {
        let mut issue = item(0, 7);
        issue.role = Role::Final;
        assert_eq!(first_unverified(&[issue], &[stored(7)]), 1);
    }

    proptest! {
        /// A record can only skip messages up to its own: with no matching record nothing is
        /// skipped, and what is skipped never reaches past the highest matching message.
        #[test]
        fn only_matching_records_skip_and_only_up_to_their_message(
            matches in proptest::collection::vec((any::<bool>(), any::<bool>()), 1..8),
        ) {
            let items: Vec<Presented> = (0..matches.len()).map(|i| item(i + 1, i as u8 + 1)).collect();
            let slots: Vec<Slot> = matches
                .iter()
                .enumerate()
                .map(|(i, (present, same))| {
                    if *present {
                        stored(if *same { i as u8 + 1 } else { 0xee })
                    } else {
                        Slot::with(None)
                    }
                })
                .collect();
            let skipped = first_unverified(&items, &slots);
            let highest = matches
                .iter()
                .enumerate()
                .filter(|(_, (present, same))| *present && *same)
                .map(|(i, _)| i + 2)
                .max();
            prop_assert_eq!(skipped, highest.unwrap_or(0));
            prop_assert!(skipped <= matches.len() + 1);
        }
    }
}
