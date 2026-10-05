use super::Key;
use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction};
use buckspay::{Link, SPENT_SEED};
use buckspay_protocol::{
    chain::{self, Holding, Output},
    lock::EXPIRY_STEP,
    record, secp256r1, Caveats, Issue, Outputs, Owner, ScopeKind, Spend,
};

/// One signed message of a chain: who must have signed which envelope.
#[derive(Clone)]
pub struct Signed {
    pub key: [u8; 33],
    pub envelope: [u8; 96],
    pub signature: [u8; 64],
}

#[derive(Clone)]
pub struct Chain {
    pub issue_body: [u8; 163],
    pub links: Vec<Link>,
    pub signed: Vec<Signed>,
    pub last: Holding,
    pub issue: Issue,
}

/// Whether an output id has a record address and a claim address under the program.
pub fn recordable(id: &[u8; 32]) -> bool {
    record::recordable(&buckspay::ID.to_bytes(), id)
}

/// `salt` with its last two bytes replaced by `n`: the signer's way of trying another id.
pub fn salted(salt: [u8; 16], n: u16) -> [u8; 16] {
    let mut out = salt;
    out[14..].copy_from_slice(&n.to_le_bytes());
    out
}

pub fn caveats(expiry: u32, hops: u8) -> Caveats {
    Caveats {
        expiry,
        hops_left: hops,
        flags: 0,
        scope_kind: ScopeKind::Any,
        scope: [0; 20],
    }
}

impl Chain {
    pub fn issue(
        issuer: &Key,
        mint: &Pubkey,
        lock_seq: u32,
        start: u64,
        amount: u64,
        owner: Owner,
        c: Caveats,
    ) -> Self {
        // The issuer changes the salt until the issue's output has a record and a claim address.
        let (issue, envelope, output) = (0u16..)
            .map(|n| {
                let issue = Issue {
                    issuer: issuer.sec1(),
                    mint: mint.to_bytes(),
                    lock_seq,
                    cum_end: start + amount,
                    salt: salted([lock_seq as u8 ^ 0x5a; 16], n),
                    owner,
                    amount,
                    caveats: c,
                };
                let (envelope, output) =
                    chain::issue_signing(&buckspay::note_domain(), &issue).unwrap();
                (issue, envelope, output)
            })
            .find(|(_, _, output)| recordable(&output.id))
            .unwrap();
        let signature = issuer.sign(&envelope);
        Chain {
            issue_body: issue.body(),
            links: vec![],
            signed: vec![Signed {
                key: issuer.sec1(),
                envelope,
                signature,
            }],
            last: Holding {
                first: output,
                second: None,
            },
            issue,
        }
    }

    /// Appends a spend of output `input` (0 payment, 1 change) of the last message, signed by
    /// `signer`, as an honest signer builds it: a payment to a device expires `EXPIRY_STEP` before
    /// the output it spends, and the salt is changed until every output the spend creates has a
    /// record address and a claim address.
    pub fn spend(self, signer: &Key, input: u8, spend: impl FnOnce(&Output) -> Spend) -> Self {
        self.spend_raw(signer, input, |consumed| {
            let mut spend = spend(consumed);
            if let Outputs::One {
                owner: Owner::Device(_),
                caveats,
            }
            | Outputs::Two {
                owner0: Owner::Device(_),
                caveats0: caveats,
                ..
            } = &mut spend.outputs
            {
                caveats.expiry = caveats.expiry.min(consumed.caveats.expiry - EXPIRY_STEP);
            }
            let salt = spend.salt;
            (0u16..)
                .map(|n| Spend {
                    salt: salted(salt, n),
                    ..spend
                })
                .find(|candidate| {
                    let env = chain::spend_signing(&buckspay::note_domain(), consumed, candidate)
                        .map(|(_, env)| env);
                    env.and_then(|env| chain::spend_outputs(&env, consumed, candidate))
                        .map_or(true, |(holding, _)| {
                            [Some(holding.first), holding.second]
                                .into_iter()
                                .flatten()
                                .all(|o| recordable(&o.id))
                        })
                })
                .unwrap()
        })
    }

    /// The same without any adjustment: for the tests that build a chain a rule must refuse.
    pub fn spend_raw(
        mut self,
        signer: &Key,
        input: u8,
        spend: impl FnOnce(&Output) -> Spend,
    ) -> Self {
        let consumed = if input == 0 {
            self.last.first
        } else {
            self.last.second.unwrap()
        };
        let spend = spend(&consumed);
        let spend = Spend {
            input: consumed.id,
            ..spend
        };
        let (_, envelope) =
            chain::spend_signing(&buckspay::note_domain(), &consumed, &spend).unwrap();
        // A chain that breaks a rule is built on purpose by the attack tests: keep the last outputs.
        let holding =
            chain::spend_outputs(&envelope, &consumed, &spend).map_or(self.last, |(h, _)| h);
        let mut body = [0u8; 123];
        let len = spend.body(&mut body);
        self.links.push(Link {
            input,
            body: body[..len].to_vec(),
        });
        self.signed.push(Signed {
            key: signer.sec1(),
            envelope,
            signature: signer.sign(&envelope),
        });
        self.last = holding;
        self
    }

    pub fn spend1_to_account(
        self,
        signer: &Key,
        input: u8,
        account: &Pubkey,
        lock_seq: u32,
        salt: u8,
    ) -> Self {
        self.spend(signer, input, |c| Spend {
            input: c.id,
            lock_seq,
            salt: [salt; 16],
            outputs: Outputs::One {
                owner: Owner::Account(account.to_bytes()),
                caveats: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
            },
        })
    }

    pub fn spend2(
        self,
        signer: &Key,
        input: u8,
        to: Owner,
        amount0: u64,
        lock_seq: u32,
        salt: u8,
    ) -> Self {
        self.spend(signer, input, |c| Spend {
            input: c.id,
            lock_seq,
            salt: [salt; 16],
            outputs: Outputs::Two {
                owner0: to,
                amount0,
                caveats0: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
                owner1: c.owner,
            },
        })
    }

    pub fn entries(&self) -> Vec<secp256r1::Expected> {
        self.signed.iter().map(|s| (s.key, s.envelope)).collect()
    }

    pub fn prefix(&self, spends: usize) -> Self {
        // The chain as it was after `spends` spends (outputs are recomputed by the caller when needed).
        let mut c = self.clone();
        c.links.truncate(spends);
        c.signed.truncate(spends + 1);
        c
    }
}

pub fn precompile_ix(entries: &[secp256r1::Expected], signatures: &[[u8; 64]]) -> Instruction {
    let mut data = vec![0u8; secp256r1::data_len(entries.len())];
    secp256r1::write(&mut data, entries, signatures).unwrap();
    Instruction {
        program_id: solana_sdk_ids::secp256r1_program::ID,
        accounts: vec![],
        data,
    }
}

pub fn spent_address(output: &[u8; 32]) -> Pubkey {
    spent_address_of(output).expect("the output has a record address")
}

/// The record address of an output, or `None` when the output cannot be recorded.
pub fn spent_address_of(output: &[u8; 32]) -> Option<Pubkey> {
    Pubkey::create_program_address(&[SPENT_SEED, output, &[record::RECORD_BUMP]], &buckspay::ID)
        .ok()
}

/// The account a transaction names for the record of `output`: its address, or an arbitrary one for
/// an output that cannot be recorded (the program refuses it before looking at the account).
pub fn record_account(output: &[u8; 32]) -> Pubkey {
    spent_address_of(output).unwrap_or_else(Pubkey::new_unique)
}

/// How many bumps from 255 down are on the curve before one is off it: what a search for the
/// canonical bump of this output would cost 1,500 CU each for.
pub fn failed_bumps(output: &[u8; 32]) -> u32 {
    (0..=255u8)
        .rev()
        .take_while(|bump| {
            Pubkey::create_program_address(&[SPENT_SEED, output, &[*bump]], &buckspay::ID).is_err()
        })
        .count() as u32
}
