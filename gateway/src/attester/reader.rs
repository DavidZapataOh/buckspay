//! Reading locks at `finalized` from two independent providers. A ticket is signed only when both
//! return the same accounts: a `Lock` is immutable, so a provider that disagrees about one is lying
//! or lagging, and neither is a reason to vouch.
use super::plan::ChainView;
use crate::chain;
use buckspay_client::{
    Program,
    accounts::{self, LEDGER_DISCRIMINATOR, LOCK_DISCRIMINATOR},
};
use buckspay_protocol::attest::LockRecord;
use solana_account::Account;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use std::{future::Future, time::Duration};

/// One lock asked about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockId {
    pub device: [u8; 33],
    pub lock_seq: u32,
}

/// What a provider says about the locks asked, and the clock of the finalized block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub unix: i64,
    pub views: Vec<ChainView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// A provider did not answer, or answered with accounts that are not the program's.
    Unavailable,
    /// The two providers disagree about a lock or about the time.
    Disagree,
}

pub trait ChainReader: Send + Sync + 'static {
    fn read(&self, locks: &[LockId]) -> impl Future<Output = Result<Snapshot, ReadError>> + Send;
}

/// The two providers' clocks may differ by this much (seconds) before they disagree.
const CLOCK_SKEW: i64 = 30;
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Providers {
    program: Program,
    clients: [RpcClient; 2],
}

impl Providers {
    /// Two providers that are not the same host: an operator that points both at one provider has
    /// no second opinion.
    pub fn new(program: Program, urls: [&str; 2]) -> Result<Self, String> {
        let host = |url: &str| {
            url.split("://")
                .last()
                .and_then(|rest| rest.split(['/', '?']).next())
                .map(str::to_owned)
        };
        if host(urls[0]).is_none() || host(urls[0]) == host(urls[1]) {
            return Err("the two RPC providers must be different hosts".into());
        }
        let client = |url: &str| {
            RpcClient::new_with_timeout_and_commitment(
                url.to_owned(),
                RPC_TIMEOUT,
                CommitmentConfig::finalized(),
            )
        };
        Ok(Self {
            program,
            clients: urls.map(client),
        })
    }

    fn addresses(&self, locks: &[LockId]) -> Vec<Pubkey> {
        let mut keys = vec![chain::CLOCK_SYSVAR];
        for lock in locks {
            let (address, _) = self.program.find_lock_pda(&lock.device, lock.lock_seq);
            let (ledger, _) = self.program.find_ledger_pda(&address);
            keys.extend([address, ledger]);
        }
        keys
    }

    async fn ask(&self, client: &RpcClient, keys: &[Pubkey]) -> Result<Snapshot, ReadError> {
        let accounts = client
            .get_multiple_accounts(keys)
            .await
            .map_err(|_| ReadError::Unavailable)?;
        decode(&self.program, &accounts)
    }
}

impl ChainReader for Providers {
    async fn read(&self, locks: &[LockId]) -> Result<Snapshot, ReadError> {
        let keys = self.addresses(locks);
        let (a, b) = tokio::join!(
            self.ask(&self.clients[0], &keys),
            self.ask(&self.clients[1], &keys)
        );
        let (a, b) = (a?, b?);
        if a.views != b.views || (a.unix - b.unix).abs() > CLOCK_SKEW {
            return Err(ReadError::Disagree);
        }
        Ok(a)
    }
}

/// `[clock, lock, ledger, lock, ledger, ...]` into a snapshot. An absent lock is `None`; an
/// account at a lock's address that the program does not own, or that does not decode, fails the
/// read.
fn decode(program: &Program, accounts: &[Option<Account>]) -> Result<Snapshot, ReadError> {
    let (clock, rest) = accounts.split_first().ok_or(ReadError::Unavailable)?;
    let unix = clock
        .as_ref()
        .and_then(|clock| chain::clock_unix(&clock.data))
        .ok_or(ReadError::Unavailable)?;
    let owned = |account: &Account| account.owner.to_bytes() == program.id().to_bytes();
    let mut views = Vec::new();
    for pair in rest.chunks(2) {
        let [lock, ledger] = pair else {
            return Err(ReadError::Unavailable);
        };
        let Some(lock) = lock else {
            views.push(ChainView {
                lock: None,
                bond_free: 0,
                bond_slashed: 0,
            });
            continue;
        };
        let ledger = ledger.as_ref().ok_or(ReadError::Unavailable)?;
        if !owned(lock) || !owned(ledger) {
            return Err(ReadError::Unavailable);
        }
        let lock = accounts::Lock::from_bytes(&lock.data).map_err(|_| ReadError::Unavailable)?;
        let ledger =
            accounts::Ledger::from_bytes(&ledger.data).map_err(|_| ReadError::Unavailable)?;
        if lock.discriminator != LOCK_DISCRIMINATOR || ledger.discriminator != LEDGER_DISCRIMINATOR
        {
            return Err(ReadError::Unavailable);
        }
        views.push(ChainView {
            lock: Some(LockRecord {
                mint: lock.mint.to_bytes(),
                bond: lock.bond,
                backing: lock.backing,
                lock_until: lock.lock_until,
            }),
            bond_free: ledger.bond_free,
            bond_slashed: ledger.bond_slashed,
        });
    }
    Ok(Snapshot { unix, views })
}
