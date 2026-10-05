//! What a settlement does with the record of one output, as a pure function so its invariants can
//! be tested without a validator.

/// The record has been paid out: the output 0 of the consuming spend, or a reclaim.
pub const PAID: u8 = 1;
/// The consumer is a reclaim, not a spend.
pub const RECLAIMED: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub content: [u8; 32],
    pub flags: u8,
}

/// Why a message is presented for an output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// An earlier spend of a chain whose last message is settled or reclaimed: only recorded.
    Prefix,
    /// The last spend of the chain: its output 0 is paid.
    Final,
    /// The owner takes the output back.
    Reclaim,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordError {
    /// The output was already consumed with another content: first settled wins.
    Conflict,
    /// The same message was already paid.
    AlreadySettled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    /// The record to store, if it is new or changes.
    pub write: Option<Record>,
    /// Whether the money for this message is paid by this call.
    pub pay: bool,
}

pub fn decide(
    existing: Option<Record>,
    role: Role,
    content: [u8; 32],
) -> Result<Decision, RecordError> {
    let flags = match role {
        Role::Prefix => 0,
        Role::Final => PAID,
        Role::Reclaim => PAID | RECLAIMED,
    };
    let Some(record) = existing else {
        return Ok(Decision {
            write: Some(Record { content, flags }),
            pay: role != Role::Prefix,
        });
    };
    if record.content != content {
        return Err(RecordError::Conflict);
    }
    if role == Role::Prefix {
        return Ok(Decision {
            write: None,
            pay: false,
        });
    }
    if record.flags & PAID != 0 {
        return Err(RecordError::AlreadySettled);
    }
    Ok(Decision {
        write: Some(Record {
            content,
            flags: record.flags | flags,
        }),
        pay: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: [u8; 32] = [1; 32];
    const B: [u8; 32] = [2; 32];

    #[test]
    fn a_new_prefix_is_recorded_unpaid_and_a_new_final_or_reclaim_is_paid() {
        assert_eq!(
            decide(None, Role::Prefix, A),
            Ok(Decision {
                write: Some(Record {
                    content: A,
                    flags: 0
                }),
                pay: false
            })
        );
        assert_eq!(
            decide(None, Role::Final, A),
            Ok(Decision {
                write: Some(Record {
                    content: A,
                    flags: PAID
                }),
                pay: true
            })
        );
        assert_eq!(
            decide(None, Role::Reclaim, A),
            Ok(Decision {
                write: Some(Record {
                    content: A,
                    flags: PAID | RECLAIMED
                }),
                pay: true
            })
        );
    }

    #[test]
    fn a_recorded_prefix_is_accepted_again_whatever_its_state() {
        for flags in [0, PAID, PAID | RECLAIMED] {
            let r = Record { content: A, flags };
            assert_eq!(
                decide(Some(r), Role::Prefix, A),
                Ok(Decision {
                    write: None,
                    pay: false
                })
            );
        }
    }

    #[test]
    fn an_unpaid_prefix_can_still_be_paid_later_once() {
        let r = Record {
            content: A,
            flags: 0,
        };
        let d = decide(Some(r), Role::Final, A).unwrap();
        assert!(d.pay);
        assert_eq!(
            d.write,
            Some(Record {
                content: A,
                flags: PAID
            })
        );
        assert_eq!(
            decide(d.write, Role::Final, A),
            Err(RecordError::AlreadySettled)
        );
    }

    #[test]
    fn another_content_is_a_conflict_for_every_role_and_state() {
        for flags in [0, PAID, PAID | RECLAIMED] {
            for role in [Role::Prefix, Role::Final, Role::Reclaim] {
                let r = Record { content: A, flags };
                assert_eq!(decide(Some(r), role, B), Err(RecordError::Conflict));
            }
        }
    }

    #[test]
    fn a_paid_record_is_never_paid_again() {
        for flags in [PAID, PAID | RECLAIMED] {
            for role in [Role::Final, Role::Reclaim] {
                let r = Record { content: A, flags };
                assert_eq!(decide(Some(r), role, A), Err(RecordError::AlreadySettled));
            }
        }
    }
}
