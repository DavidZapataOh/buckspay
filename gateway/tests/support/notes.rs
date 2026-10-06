//! Notes the way a wallet builds them: signed by real P-256 keys, with the salts changed until every
//! output has a record address and a claim address and a payment to a device stepping its expiry down.
#![allow(dead_code)]
use super::*;
use buckspay_protocol::{
    Caveats, Issue, Outputs, Owner, ScopeKind, Signed as SignedMessage, Spend,
    chain::{self, Holding, Output},
    lock::EXPIRY_STEP,
    reclaim::reclaim_envelope,
    record,
};

pub const AMOUNT: u64 = 50_000_000;

pub fn note_domain() -> [u8; 32] {
    domain(
        purpose::NOTE,
        &DEVNET_GENESIS_HASH,
        &program().id().to_bytes(),
    )
}

pub fn reclaim_domain() -> [u8; 32] {
    domain(
        purpose::RECLAIM,
        &DEVNET_GENESIS_HASH,
        &program().id().to_bytes(),
    )
}

pub fn recordable(id: &[u8; 32]) -> bool {
    record::recordable(&program().id().to_bytes(), id)
}

pub fn caveats(expiry: u32, hops_left: u8) -> Caveats {
    Caveats {
        expiry,
        hops_left,
        flags: 0,
        scope_kind: ScopeKind::Any,
        scope: [0; 20],
    }
}

impl Device {
    pub fn owner(&self) -> Owner {
        Owner::Device(self.key())
    }
}

/// An issue and the spends that follow it, with the outputs of the last message.
#[derive(Clone)]
pub struct Note {
    pub issue: SignedMessage<Issue>,
    pub spends: Vec<SignedMessage<Spend>>,
    pub last: Holding,
}

fn salted(salt: u8, n: u16) -> [u8; 16] {
    let mut out = [salt; 16];
    out[14..].copy_from_slice(&n.to_le_bytes());
    out
}

/// An issue of `amount` out of the lock `lock_seq` of `issuer`, over `[start, start + amount)`.
pub fn issue(
    issuer: &Device,
    mint: &Pubkey,
    lock_seq: u32,
    start: u64,
    amount: u64,
    owner: Owner,
    caveats: Caveats,
) -> Note {
    let domain = note_domain();
    let (message, envelope, output) = (0u16..)
        .map(|n| {
            let message = Issue {
                issuer: issuer.key(),
                mint: mint.to_bytes(),
                lock_seq,
                cum_end: start + amount,
                salt: salted(0x5a, n),
                owner,
                amount,
                caveats,
            };
            let (envelope, output) = chain::issue_signing(&domain, &message).unwrap();
            (message, envelope, output)
        })
        .find(|(_, _, output)| recordable(&output.id))
        .unwrap();
    Note {
        issue: SignedMessage {
            message,
            signature: issuer.sign(&envelope),
        },
        spends: vec![],
        last: Holding {
            first: output,
            second: None,
        },
    }
}

impl Note {
    /// Appends a spend of output `input` of the last message, signed by `signer`.
    pub fn spend(mut self, signer: &Device, input: u8, outputs: Outputs, lock_seq: u32) -> Self {
        let consumed: Output = if input == 0 {
            self.last.first
        } else {
            self.last.second.unwrap()
        };
        let domain = note_domain();
        let outputs = match outputs {
            Outputs::One {
                owner: owner @ Owner::Device(_),
                mut caveats,
            } => {
                caveats.expiry = caveats.expiry.min(consumed.caveats.expiry - EXPIRY_STEP);
                Outputs::One { owner, caveats }
            }
            Outputs::Two {
                owner0: owner0 @ Owner::Device(_),
                amount0,
                mut caveats0,
                owner1,
            } => {
                caveats0.expiry = caveats0.expiry.min(consumed.caveats.expiry - EXPIRY_STEP);
                Outputs::Two {
                    owner0,
                    amount0,
                    caveats0,
                    owner1,
                }
            }
            other => other,
        };
        let (message, envelope, holding) = (0u16..)
            .map(|n| {
                let message = Spend {
                    input: consumed.id,
                    lock_seq,
                    salt: salted(0x77, n),
                    outputs,
                };
                let (_, envelope) = chain::spend_signing(&domain, &consumed, &message).unwrap();
                let (holding, _) = chain::spend_outputs(&envelope, &consumed, &message).unwrap();
                (message, envelope, holding)
            })
            .find(|(_, _, holding)| {
                [Some(holding.first), holding.second]
                    .into_iter()
                    .flatten()
                    .all(|o| recordable(&o.id))
            })
            .unwrap();
        self.spends.push(SignedMessage {
            message,
            signature: signer.sign(&envelope),
        });
        self.last = holding;
        self
    }

    /// A settlement: the whole output of the last message to a terminal account, with no lock.
    pub fn settle_to(self, signer: &Device, input: u8, account: &Pubkey) -> Self {
        let consumed = if input == 0 {
            self.last.first
        } else {
            self.last.second.unwrap()
        };
        self.spend(
            signer,
            input,
            Outputs::One {
                owner: Owner::Account(account.to_bytes()),
                caveats: Caveats {
                    hops_left: consumed.caveats.hops_left.saturating_sub(1),
                    ..consumed.caveats
                },
            },
            buckspay_protocol::NO_LOCK,
        )
    }

    /// A payment of `amount` to `to` with the change kept by `signer`.
    pub fn pay(self, signer: &Device, input: u8, to: Owner, amount: u64) -> Self {
        let consumed = if input == 0 {
            self.last.first
        } else {
            self.last.second.unwrap()
        };
        self.spend(
            signer,
            input,
            Outputs::Two {
                owner0: to,
                amount0: amount,
                caveats0: Caveats {
                    hops_left: consumed.caveats.hops_left - 1,
                    ..consumed.caveats
                },
                owner1: consumed.owner,
            },
            0,
        )
    }

    /// The first `spends` spends only.
    pub fn prefix(&self, spends: usize) -> Self {
        let mut note = self.clone();
        note.spends.truncate(spends);
        note
    }

    pub fn issue_hex(&self) -> String {
        hex::encode(self.issue.encode())
    }

    pub fn spend_hexes(&self) -> Vec<String> {
        self.spends
            .iter()
            .map(|spend| {
                let mut out = [0; 219];
                let len = spend.encode(&mut out);
                hex::encode(&out[..len])
            })
            .collect()
    }

    pub fn settlement_request(&self) -> Value {
        json!({ "issue": self.issue_hex(), "spends": self.spend_hexes() })
    }

    /// A reclaim of output `which` of the last message by `owner`, valid until `deadline`.
    pub fn reclaim_request(&self, owner: &Device, which: u8, deadline: u32) -> Value {
        let output = if which == 0 {
            self.last.first
        } else {
            self.last.second.unwrap()
        };
        let envelope = reclaim_envelope(&reclaim_domain(), &output.id, deadline);
        json!({
            "owner": hex::encode(owner.key()),
            "issue": self.issue_hex(),
            "spends": self.spend_hexes(),
            "which": which,
            "deadline": deadline,
            "signature": hex::encode(owner.sign(&envelope)),
        })
    }

    /// The record address of every output the spends consumed, or the issue's own output.
    pub fn record_addresses(&self) -> Vec<Pubkey> {
        let mut ids: Vec<[u8; 32]> = self.spends.iter().map(|s| s.message.input).collect();
        if ids.is_empty() {
            let (_, output) = chain::issue_signing(&note_domain(), &self.issue.message).unwrap();
            ids.push(output.id);
        }
        ids.iter()
            .map(|id| {
                Pubkey::new_from_array(record::address(&program().id().to_bytes(), id).unwrap())
            })
            .collect()
    }
}

/// A device that is registered and has a funded lock, made through the gateway's own onboarding.
pub struct Issuer {
    pub device: Device,
    pub wallet: Wallet,
    pub lock_until: u32,
}

impl Issuer {
    /// Onboards a fresh device with a lock of `bond` and `backing` that lasts `seconds` more.
    pub async fn new(sponsor: &Sponsor, bond: u64, backing: u64, seconds: u32) -> Self {
        Self::with_device(sponsor, Device::random(), bond, backing, seconds).await
    }

    /// The same for a device that is given.
    pub async fn with_device(
        sponsor: &Sponsor,
        device: Device,
        bond: u64,
        backing: u64,
        seconds: u32,
    ) -> Self {
        let wallet = wallet(bond + backing).await;
        let lock_until = chain_now().await + seconds;
        let prepared = sponsor
            .prepare(
                "/v1/onboard",
                &device.onboard_request(&wallet, bond, backing, lock_until),
            )
            .await;
        let (status, body) = sponsor
            .submit(
                "/v1/onboard/submit",
                &device.key(),
                &prepared.signed_by(&wallet.keypair),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        Self {
            device,
            wallet,
            lock_until,
        }
    }

    pub fn lock(&self) -> Pubkey {
        program().find_lock_pda(&self.device.key(), 0).0
    }

    /// An issue of `amount` from `start` to this device itself.
    pub fn issue_to_self(&self, start: u64, amount: u64, expiry: u32) -> Note {
        issue(
            &self.device,
            &cluster().mint,
            0,
            start,
            amount,
            self.device.owner(),
            caveats(expiry, 6),
        )
    }

    /// An issue of `amount` from `start` that pays `account` as it is, with no spend after it.
    pub fn issue_to_account(&self, start: u64, amount: u64, expiry: u32, account: &Pubkey) -> Note {
        issue(
            &self.device,
            &cluster().mint,
            0,
            start,
            amount,
            Owner::Account(account.to_bytes()),
            caveats(expiry, 3),
        )
    }

    /// An issue to `holder`.
    pub fn issue_to(&self, holder: &Device, start: u64, amount: u64, expiry: u32) -> Note {
        self.issue_with_hops(holder, start, amount, expiry, 6)
    }

    /// An issue to `holder` that can be passed on `hops` times.
    pub fn issue_with_hops(
        &self,
        holder: &Device,
        start: u64,
        amount: u64,
        expiry: u32,
        hops: u8,
    ) -> Note {
        issue(
            &self.device,
            &cluster().mint,
            0,
            start,
            amount,
            holder.owner(),
            caveats(expiry, hops),
        )
    }
}
