//! Plans the transactions that settle a chain longer than one precompile instruction carries.
//! Each batch re-supplies the issue and every body from the issue, so the size of a batch is what
//! binds first; the signatures to verify are only those no record vouches for yet.
use crate::settlements::Consumed;
use buckspay_protocol::{MAX_DEPTH, record::vouched_prefix, secp256r1::MAX_SIGNATURES};

/// The flag of a record that holds a reclaim, which vouches for no message.
pub const RECLAIMED: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    RecordPrefix,
    Settle,
}

/// One transaction: the chain cut after `spends` spends, with the messages before `covered`
/// vouched for by records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Batch {
    pub spends: usize,
    pub covered: usize,
    pub step: Step,
}

impl Batch {
    /// The signatures this batch's precompile instruction carries.
    pub fn signatures(&self) -> usize {
        (self.spends + 1).saturating_sub(self.covered)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PlanError {
    TooLong,
    DoesNotFit { spends: usize, covered: usize },
}

/// What the gateway read of a record account.
#[derive(Clone, Copy, Debug)]
pub struct RecordView {
    pub content: [u8; 32],
    pub flags: u8,
}

/// The batches that settle a chain of `total` spends whose first `recorded` messages are already
/// vouched for on chain. Greedy: each batch takes the most new messages `fits` accepts, never more
/// than `MAX_SIGNATURES`; the last is the settlement.
pub fn plan_batches(
    total: usize,
    recorded: usize,
    fits: impl Fn(&Batch) -> bool,
) -> Result<Vec<Batch>, PlanError> {
    if total > usize::from(MAX_DEPTH) {
        return Err(PlanError::TooLong);
    }
    let mut covered = recorded.min(total + 1);
    let mut plan = Vec::new();
    loop {
        let settle = Batch {
            spends: total,
            covered,
            step: Step::Settle,
        };
        if settle.signatures() <= MAX_SIGNATURES && fits(&settle) {
            plan.push(settle);
            return Ok(plan);
        }
        // A prefix has at least one spend and ends before the last, which only a settlement ends.
        let first = covered.max(1);
        let last = (covered + MAX_SIGNATURES - 1).min(total.saturating_sub(1));
        let next = (first..=last)
            .rev()
            .map(|spends| Batch {
                spends,
                covered,
                step: Step::RecordPrefix,
            })
            .find(|batch| fits(batch))
            .ok_or(PlanError::DoesNotFit {
                spends: first,
                covered,
            })?;
        covered = next.spends + 1;
        plan.push(next);
    }
}

/// How many messages of the chain the records vouch for: the highest message index of a record
/// that exists, is not `RECLAIMED` and holds the chain's content, plus one; gaps are allowed, as in
/// the program, which this is the off-chain twin of.
pub(crate) fn recorded_prefix(consumed: &[Consumed], records: &[Option<RecordView>]) -> usize {
    vouched_prefix(
        consumed
            .iter()
            .zip(records)
            .enumerate()
            .map(|(index, (consumed, record))| {
                (
                    Some(index + 1),
                    record.is_some_and(|record| {
                        record.content == consumed.content && record.flags & RECLAIMED == 0
                    }),
                )
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The size model of the program's batches (627 + 161 n + 207 k bytes, 4,096 max), standing in
    /// for the real builder in unit tests only.
    fn model(b: &Batch) -> bool {
        let k = (b.spends + 1).saturating_sub(b.covered);
        627 + 161 * b.spends + 207 * k <= 4_096
    }

    #[test]
    fn a_short_chain_is_one_settlement() {
        assert_eq!(
            plan_batches(3, 0, model).unwrap(),
            vec![Batch {
                spends: 3,
                covered: 0,
                step: Step::Settle
            }]
        );
    }

    #[test]
    fn sixteen_spends_take_three_batches_each_with_at_most_eight_signatures() {
        let plan = plan_batches(16, 0, model).unwrap();
        assert_eq!(
            plan,
            vec![
                Batch {
                    spends: 7,
                    covered: 0,
                    step: Step::RecordPrefix
                },
                Batch {
                    spends: 13,
                    covered: 8,
                    step: Step::RecordPrefix
                },
                Batch {
                    spends: 16,
                    covered: 14,
                    step: Step::Settle
                },
            ]
        );
        for b in &plan {
            assert!(b.spends + 1 - b.covered <= 8);
        }
    }

    #[test]
    fn a_resume_starts_from_what_is_recorded() {
        let plan = plan_batches(16, 8, model).unwrap();
        assert_eq!(
            plan[0],
            Batch {
                spends: 13,
                covered: 8,
                step: Step::RecordPrefix
            }
        );
        assert_eq!(plan.last().unwrap().step, Step::Settle);
    }

    #[test]
    fn a_fully_recorded_chain_is_one_settlement_without_signatures_but_the_last() {
        assert_eq!(
            plan_batches(16, 16, model).unwrap(),
            vec![Batch {
                spends: 16,
                covered: 16,
                step: Step::Settle
            }]
        );
    }

    #[test]
    fn a_chain_recorded_to_the_last_message_needs_no_signature() {
        assert_eq!(
            plan_batches(16, 17, model).unwrap(),
            vec![Batch {
                spends: 16,
                covered: 17,
                step: Step::Settle
            }]
        );
    }

    #[test]
    fn more_than_max_depth_spends_is_too_long() {
        assert_eq!(plan_batches(17, 0, model), Err(PlanError::TooLong));
    }

    #[test]
    fn a_batch_that_fits_nothing_new_is_reported_not_looped() {
        assert_eq!(
            plan_batches(16, 0, |_| false),
            Err(PlanError::DoesNotFit {
                spends: 1,
                covered: 0
            })
        );
    }

    #[test]
    fn plans_cover_every_message_once_and_end_in_a_settlement() {
        for total in 0..=16 {
            for recorded in 0..=total + 1 {
                let plan = plan_batches(total, recorded, model).unwrap();
                assert_eq!(plan.last().unwrap().step, Step::Settle);
                assert_eq!(plan.last().unwrap().spends, total);
                let mut covered = recorded.min(total + 1);
                for b in &plan {
                    assert_eq!(b.covered, covered);
                    assert!((b.spends + 1).saturating_sub(b.covered) <= MAX_SIGNATURES);
                    covered = b.spends + 1;
                }
            }
        }
    }

    #[test]
    fn the_recorded_prefix_is_the_highest_matching_record_plus_one() {
        let c = |n: u8| Consumed {
            output: [n; 32],
            content: [n; 32],
            expiry: 0,
            unlocked: false,
        };
        let r = |n: u8, flags: u8| {
            Some(RecordView {
                content: [n; 32],
                flags,
            })
        };
        let consumed = [c(1), c(2), c(3), c(4)];
        assert_eq!(
            recorded_prefix(&consumed, &[r(1, 0), r(2, 0), None, r(4, 0)]),
            5
        );
        assert_eq!(
            recorded_prefix(&consumed, &[r(1, 0), r(9, 0), r(3, 0), None]),
            4
        );
        assert_eq!(recorded_prefix(&consumed, &[r(1, 0), None, None, None]), 2);
        assert_eq!(
            recorded_prefix(&consumed, &[r(1, 0), r(2, 0), r(9, 0), None]),
            3,
            "a record of another content at the highest message vouches for nothing"
        );
        assert_eq!(recorded_prefix(&consumed, &[None, None, None, None]), 0);
        assert_eq!(
            recorded_prefix(&consumed, &[r(1, RECLAIMED), None, None, None]),
            0
        );
        assert_eq!(
            recorded_prefix(&consumed, &[r(1, 0), r(2, 0), r(3, 0), r(4, 0)]),
            5
        );
    }
}
