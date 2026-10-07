//! Returns the rents the gateway lends. Every lock it paid for is released to its wallet and closed,
//! and every rotation it paid for is applied, once nobody else has done it: the float of sponsored
//! onboarding comes back without depending on a wallet or an app showing up.
//!
//! It never creates the wallet's associated token account. The rent of that account would be a
//! gift to the wallet, which can reclaim it by closing the account again, so a sybil would profit
//! from every key; a lock whose wallet has no token account stays open and is counted as stuck.
use crate::{
    chain::{self, TokenAccount, associated_token_address},
    claims::{CLAIM_CLOSABLE_OFFSET, CLAIM_LEN, CLAIM_PAYER_OFFSET, claim_discriminator},
    float::{Found, Read},
    onboard::{chain_now, read},
    server::{Error, Gateway},
    settlements::{RECORD_LEN, RECORD_PAYER_OFFSET, resume, spent_discriminator},
    sponsored::{Outcome, confirm, unreachable},
    transactions::{self, Withdrawal},
    zk::{STALE_BUFFER_SECS, account_discriminator},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::accounts::{Channel, Device, Ledger, Lock, Rotation};
use buckspay_protocol::lock::Windows;
use solana_account::Account;
use solana_account_decoder_client_types::UiDataSliceConfig;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    filter::{Memcmp, RpcFilterType},
};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    collections::HashSet,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tracing::{info, warn};

/// How long a rotation the gateway paid for may wait after it can be applied, so its wallet has had
/// time to cancel it before anyone applies it for them.
pub const ROTATION_GRACE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Transactions one run sends at most.
const TRANSACTIONS_PER_RUN: usize = 10;
const COMPUTE_UNIT_LIMIT: u32 = 60_000;
/// Settlement jobs one run takes up at most.
const JOBS_PER_RUN: usize = 10;
/// Settlement records one `close_spent` closes, and the compute units it is given: a pair costs
/// a few thousand.
const CLOSE_BATCH: usize = 20;
const CLOSE_COMPUTE_UNIT_LIMIT: u32 = 100_000;
/// The most lamports of rent one rotation of the reward tree may cost the gateway.
pub const ROTATION_BUDGET_LAMPORTS: u64 = 100_000_000;
/// Where a reward tree says how many leaves it holds: after its discriminator, mint and epoch.
const TREE_NEXT_INDEX_OFFSET: usize = 44;
const OFFSET_OF_LEDGER_PAYER: usize = 32;
const OFFSET_OF_ROTATION_PAYER: usize = 40;
/// Where a proof buffer says when it was created: after its discriminator, payer, nonce, length
/// and the bytes written.
const BUFFER_CREATED_AT_OFFSET: usize = 56;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub released: u32,
    pub closed: u32,
    pub applied: u32,
    /// Locks that are due but whose wallet has no token account to release to.
    pub stuck: u32,
    /// Settlement records closed, forgotten because the chain never showed them, and adopted
    /// because the ledger did not know them.
    pub settlements_closed: u32,
    pub settlements_forgotten: u32,
    pub settlements_adopted: u32,
    /// Claims closed: the rent the gateway fronted for them is back.
    pub claims_closed: u32,
    /// Settlements of several transactions that were looked at again.
    pub jobs_resumed: u32,
    /// Channels closed: the rent the gateway fronted for them is back.
    pub channels_closed: u32,
    /// Reward trees rotated because the current one was full.
    pub trees_rotated: u32,
    /// Proof buffers nobody settled within their stale time: the rent is back.
    pub buffers_closed: u32,
}

/// The accounts of the program of `size` bytes whose payer, at `offset`, is the gateway.
pub(crate) async fn paid_by_us(
    state: &Gateway,
    size: u64,
    offset: usize,
) -> Result<Vec<(Pubkey, Account)>, Error> {
    let fee_payer = state.fee_payer.pubkey();
    let accounts = state
        .rpc
        .get_program_ui_accounts_with_config(
            &state.settings.program.id(),
            RpcProgramAccountsConfig {
                filters: Some(vec![
                    RpcFilterType::DataSize(size),
                    RpcFilterType::Memcmp(Memcmp::new_base58_encoded(offset, fee_payer.as_ref())),
                ]),
                account_config: RpcAccountInfoConfig {
                    encoding: Some(solana_account_decoder_client_types::UiAccountEncoding::Base64),
                    commitment: Some(state.rpc.commitment()),
                    ..RpcAccountInfoConfig::default()
                },
                ..RpcProgramAccountsConfig::default()
            },
        )
        .await
        .map_err(unreachable)?;
    Ok(accounts
        .into_iter()
        .filter_map(|(address, account)| Some((address, account_of(account)?)))
        .collect())
}

fn account_of(ui: solana_account_decoder_client_types::UiAccount) -> Option<Account> {
    use solana_account_decoder_client_types::{UiAccountData, UiAccountEncoding};
    let UiAccountData::Binary(data, UiAccountEncoding::Base64) = ui.data else {
        return None;
    };
    Some(Account {
        lamports: ui.lamports,
        data: BASE64_STANDARD.decode(data).ok()?,
        owner: ui.owner.parse().ok()?,
        executable: ui.executable,
        rent_epoch: ui.rent_epoch,
    })
}

/// Sends `instructions` with the gateway as the only signer and waits for the outcome.
async fn send(state: &Gateway, instructions: &[Instruction]) -> bool {
    send_with_limit(state, instructions, COMPUTE_UNIT_LIMIT).await
}

async fn send_with_limit(state: &Gateway, instructions: &[Instruction], limit: u32) -> bool {
    let fee_payer = state.fee_payer.pubkey();
    let Ok((blockhash, _)) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
    else {
        return false;
    };
    let message = transactions::compose(&fee_payer, limit, 0, instructions, blockhash);
    let transaction = VersionedTransaction {
        signatures: vec![state.fee_payer.sign_message(&message.serialize())],
        message,
    };
    let Ok(signature) = state.rpc.send_transaction(&transaction).await else {
        return false;
    };
    confirm(state, &signature).await == Outcome::Landed
}

/// What a lock needs now.
#[derive(Debug, PartialEq, Eq)]
pub enum Due {
    Nothing,
    /// Pay the wallet what remains; `close` also closes the records, in the same transaction.
    Release {
        close: bool,
    },
    /// Close the records of a lock whose escrow is already gone.
    Close,
}

/// Whether a lock is due for release or close at `now`. A slash still in the pool keeps the escrow
/// open and the records with it: the release pays the rest, and the close waits for the pool to be
/// paid.
pub fn due(ledger: &Ledger, lock: &Lock, escrow_open: bool, now: u64, windows: &Windows) -> Due {
    let lock_until = u64::from(lock.lock_until);
    let release_due = now >= lock_until + u64::from(windows.claim_window + windows.release_delay);
    let close_due = now >= lock_until + u64::from(windows.record_ttl()) && ledger.bond_slashed == 0;
    if escrow_open && release_due {
        Due::Release { close: close_due }
    } else if !escrow_open && ledger.withdrawn && close_due {
        Due::Close
    } else {
        Due::Nothing
    }
}

/// Words waiting to be sent are sent, the channels past their close time are closed with their
/// rent coming back, and a full reward tree is rotated so that settling words never stops.
async fn tend_channels(state: &Gateway, now: u64, report: &mut Report) -> Result<(), Error> {
    crate::channels::resume_pending(state).await;
    let open = paid_by_us(
        state,
        Channel::LEN as u64,
        crate::channels::CHANNEL_PAYER_OFFSET,
    )
    .await?;
    let due = crate::channels::closing(
        &state.settings.program,
        &open,
        u32::try_from(now).unwrap_or(u32::MAX),
        CLOSE_BATCH,
    );
    if !due.is_empty() {
        let count = due.len() as u32;
        if send_with_limit(state, &due, CLOSE_COMPUTE_UNIT_LIMIT).await {
            report.channels_closed += count;
        }
    }
    rotate_full_tree(state, report).await
}

/// Rotates the reward tree of the mint when it is full, paying the rent of the next one up to
/// `ROTATION_BUDGET_LAMPORTS`.
async fn rotate_full_tree(state: &Gateway, report: &mut Report) -> Result<(), Error> {
    use buckspay_client::{accounts::RewardMint, instructions::RotateRewardTree};
    let program = state.settings.program;
    let reward_mint = Pubkey::find_program_address(
        &[b"reward-mint", state.settings.mint.as_ref()],
        &program.id(),
    )
    .0;
    let Some(pool) = read(state, &[reward_mint])
        .await?
        .remove(0)
        .and_then(|account| RewardMint::from_bytes(&account.data).ok())
    else {
        return Ok(());
    };
    let tree = |epoch: u32| {
        Pubkey::find_program_address(
            &[b"reward-tree", pool.mint.as_ref(), &epoch.to_le_bytes()],
            &program.id(),
        )
        .0
    };
    let Some(account) = read(state, &[tree(pool.epoch)]).await?.remove(0) else {
        return Ok(());
    };
    let Some(next_index) = account
        .data
        .get(TREE_NEXT_INDEX_OFFSET..TREE_NEXT_INDEX_OFFSET + 4)
        .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
        .map(u32::from_le_bytes)
    else {
        return Ok(());
    };
    if !crate::channels::tree_is_full(next_index) {
        return Ok(());
    }
    let rent = state
        .rpc
        .get_minimum_balance_for_rent_exemption(buckspay_client::accounts::RewardTree::LEN)
        .await
        .map_err(unreachable)?;
    if rent > ROTATION_BUDGET_LAMPORTS {
        warn!(
            rent,
            "a full reward tree needs more rent than the rotation budget"
        );
        return Ok(());
    }
    let rotate = RotateRewardTree {
        payer: state.fee_payer.pubkey(),
        reward_mint,
        current: tree(pool.epoch),
        next: tree(pool.epoch + 1),
        system_program: Pubkey::default(),
    }
    .instruction();
    let rotate = program.target(rotate);
    if send_with_limit(state, &[rotate], COMPUTE_UNIT_LIMIT).await {
        report.trees_rotated += 1;
    }
    Ok(())
}

/// One pass over everything the gateway paid for.
pub async fn run_once(state: &Gateway, rotation_grace: Duration) -> Result<Report, Error> {
    let program = state.settings.program;
    let ledgers = paid_by_us(state, Ledger::LEN as u64, OFFSET_OF_LEDGER_PAYER).await?;
    let rotations = paid_by_us(state, Rotation::LEN as u64, OFFSET_OF_ROTATION_PAYER).await?;
    let now = u64::from(chain_now(
        &read(state, &[chain::CLOCK_SYSVAR]).await?.remove(0),
    )?);
    state.hpke.sweep_retired(now);
    let mut report = Report::default();
    let mut sent = 0;
    let mut open = ledgers.len() as u64;
    let windows = state.settings.windows;

    for (ledger_address, account) in &ledgers {
        let Ok(ledger) = Ledger::from_bytes(&account.data) else {
            continue;
        };
        let lock_address = program.find_lock_pda(&ledger.key, ledger.lock_seq).0;
        let escrow = program.find_escrow_pda(&lock_address).0;
        let mint = state.settings.mint;
        let accounts = read(
            state,
            &[
                lock_address,
                program.find_device_pda(&ledger.key).0,
                escrow,
                mint,
            ],
        )
        .await?;
        let (Some(lock), Some(device)) = (
            accounts[0]
                .as_ref()
                .and_then(|a| Lock::from_bytes(&a.data).ok()),
            accounts[1]
                .as_ref()
                .and_then(|a| Device::from_bytes(&a.data).ok()),
        ) else {
            continue;
        };
        let escrow_open = accounts[2].is_some();
        let mut instructions = Vec::new();
        match due(&ledger, &lock, escrow_open, now, &windows) {
            Due::Nothing => {}
            Due::Release { close } => {
                let token_program = accounts[3]
                    .as_ref()
                    .map_or(chain::TOKEN_PROGRAM, |m| m.owner);
                let destination =
                    associated_token_address(&device.wallet, &lock.mint, &token_program);
                let usable = read(state, &[destination])
                    .await?
                    .remove(0)
                    .is_some_and(|account| {
                        account.owner == token_program
                            && TokenAccount::parse(&account.data).is_some_and(|t| {
                                t.owner == device.wallet && t.mint == lock.mint && !t.frozen
                            })
                    });
                if !usable {
                    report.stuck += 1;
                    continue;
                }
                instructions.push(transactions::release(
                    &program,
                    &Withdrawal {
                        wallet: device.wallet,
                        rent_receiver: ledger.payer,
                        key: ledger.key,
                        lock_seq: ledger.lock_seq,
                        mint: lock.mint,
                        token_program,
                        destination,
                    },
                ));
                if close {
                    instructions.push(transactions::close(
                        &program,
                        &ledger.key,
                        ledger.lock_seq,
                        &ledger.payer,
                    ));
                }
            }
            Due::Close => {
                instructions.push(transactions::close(
                    &program,
                    &ledger.key,
                    ledger.lock_seq,
                    &ledger.payer,
                ));
            }
        }
        if instructions.is_empty() || sent == TRANSACTIONS_PER_RUN {
            continue;
        }
        let (released, closed) = (escrow_open, instructions.len() == 2 || !escrow_open);
        sent += 1;
        if send(state, &instructions).await {
            if released {
                report.released += 1;
            }
            if closed {
                report.closed += 1;
                open = open.saturating_sub(1);
            }
            info!(ledger = %ledger_address, "returned the rent of a sponsored lock");
        } else {
            warn!("a janitor transaction did not land");
        }
    }

    let mut lent = 0;
    for (address, account) in &rotations {
        let Ok(rotation) = Rotation::from_bytes(&account.data) else {
            continue;
        };
        if now >= u64::from(rotation.effective_at) + rotation_grace.as_secs()
            && sent < TRANSACTIONS_PER_RUN
        {
            // A rotation account does not hold its device key, so only the rotations this process
            // sponsored can be applied; anyone else's wait for their owners, who can apply them too.
            let key = state.rotation_keys.lock().unwrap().get(address).copied();
            if let Some(key) = key {
                sent += 1;
                if send(
                    state,
                    &[transactions::apply_rotation(
                        &program,
                        &key,
                        &rotation.payer,
                    )],
                )
                .await
                {
                    state.rotation_keys.lock().unwrap().remove(address);
                    report.applied += 1;
                    continue;
                }
            }
        }
        lent += account.lamports;
    }

    if let Err(error) = settlement_records(state, now, &mut report).await {
        warn!(?error, "the settlement records could not be tended");
    }
    if let Err(error) = close_claims(state, now, &mut report).await {
        warn!(?error, "the claims could not be tended");
    }
    for job in state.jobs.pending().iter().take(JOBS_PER_RUN) {
        resume(state, job).await;
        report.jobs_resumed += 1;
    }
    if let Err(error) = tend_channels(state, now, &mut report).await {
        warn!(?error, "the channels could not be tended");
    }
    if let Err(error) = close_buffers(state, now, &mut report).await {
        warn!(?error, "the proof buffers could not be tended");
    }
    state
        .stuck
        .store(u64::from(report.stuck), Ordering::Relaxed);
    if let Err(error) = state.sponsor.reconcile_open_locks(open) {
        warn!(%error, "the sponsorship ledger could not be written");
    }
    if let Err(error) = state.sponsor.reconcile_rotation_float(lent) {
        warn!(%error, "the sponsorship ledger could not be written");
    }
    Ok(report)
}

/// The claims the gateway paid for that are still open, each with the second it can be closed.
/// Read from the chain alone: a restart loses nothing and a claim nobody remembers is found.
pub async fn open_claims(state: &Gateway) -> Result<Vec<(Pubkey, u32)>, Error> {
    let discriminator = claim_discriminator();
    Ok(paid_by_us(state, CLAIM_LEN, CLAIM_PAYER_OFFSET)
        .await?
        .into_iter()
        .filter(|(_, account)| account.data[..8] == discriminator)
        .filter_map(|(address, account)| {
            let closable = account.data[CLAIM_CLOSABLE_OFFSET..].try_into().ok()?;
            Some((address, u32::from_le_bytes(closable)))
        })
        .collect())
}

/// Closes the claims that are due, with the rent going back to the fee payer that fronted it.
async fn close_claims(state: &Gateway, now: u64, report: &mut Report) -> Result<(), Error> {
    let fee_payer = state.fee_payer.pubkey();
    let pairs: Vec<(Pubkey, Pubkey)> = open_claims(state)
        .await?
        .into_iter()
        .filter(|(_, closable_at)| u64::from(*closable_at) <= now)
        .take(CLOSE_BATCH)
        .map(|(address, _)| (address, fee_payer))
        .collect();
    if pairs.is_empty() {
        return Ok(());
    }
    let close = transactions::close_records(&state.settings.program, &pairs);
    if send_with_limit(state, &[close], CLOSE_COMPUTE_UNIT_LIMIT).await {
        report.claims_closed += u32::try_from(pairs.len()).unwrap_or(u32::MAX);
        info!(claims = pairs.len(), "returned the rent of claims");
    } else {
        warn!("a claim close did not land");
    }
    Ok(())
}

/// The proof buffers whose rent can come back: the ones created `STALE_BUFFER_SECS` before `now`
/// or earlier, by their addresses.
fn stale_buffers(found: &[(Pubkey, u32)], now: u64) -> Vec<Pubkey> {
    found
        .iter()
        .filter(|(_, created_at)| u64::from(*created_at) + u64::from(STALE_BUFFER_SECS) <= now)
        .map(|(address, _)| *address)
        .collect()
}

/// Closes the proof buffers of settlements that were never finished, as their payer.
async fn close_buffers(state: &Gateway, now: u64, report: &mut Report) -> Result<(), Error> {
    let program = state.settings.program;
    let payer = state.fee_payer.pubkey();
    let accounts = state
        .rpc
        .get_program_ui_accounts_with_config(
            &program.id(),
            RpcProgramAccountsConfig {
                filters: Some(vec![
                    RpcFilterType::Memcmp(Memcmp::new_base58_encoded(
                        0,
                        &account_discriminator("ProofBuffer"),
                    )),
                    RpcFilterType::Memcmp(Memcmp::new_base58_encoded(8, payer.as_ref())),
                ]),
                account_config: RpcAccountInfoConfig {
                    encoding: Some(solana_account_decoder_client_types::UiAccountEncoding::Base64),
                    data_slice: Some(UiDataSliceConfig {
                        offset: BUFFER_CREATED_AT_OFFSET,
                        length: 4,
                    }),
                    commitment: Some(state.rpc.commitment()),
                    ..RpcAccountInfoConfig::default()
                },
                ..RpcProgramAccountsConfig::default()
            },
        )
        .await
        .map_err(unreachable)?;
    let found: Vec<(Pubkey, u32)> = accounts
        .into_iter()
        .filter_map(|(address, account)| {
            let account = account_of(account)?;
            Some((
                address,
                u32::from_le_bytes(account.data.get(..4)?.try_into().ok()?),
            ))
        })
        .collect();
    for address in stale_buffers(&found, now).into_iter().take(CLOSE_BATCH) {
        if send(
            state,
            &[transactions::close_proof_buffer(&program, payer, address)],
        )
        .await
        {
            report.buffers_closed += 1;
            info!("returned the rent of a proof buffer");
        } else {
            warn!("a proof buffer close did not land");
        }
    }
    Ok(())
}

/// The settlement records the gateway paid for: brings its ledger in line with a confirmed read of
/// the chain, closes the ones that are due and adopts the ones it did not know it had.
async fn settlement_records(state: &Gateway, now: u64, report: &mut Report) -> Result<(), Error> {
    let program = state.settings.program;
    let now = u32::try_from(now).map_err(|_| Error::Upstream)?;
    let io = |error: std::io::Error| {
        warn!(%error, "the settlement ledger could not be written");
        Error::Upstream
    };

    // Reconcile: the records the ledger holds, read in chunks of what the RPC takes at once. The
    // read counts as old as its oldest chunk.
    let open = state.settlements.open_addresses();
    if !open.is_empty() {
        let (mut slot, mut existing) = (u64::MAX, HashSet::new());
        for chunk in open.chunks(100) {
            let keys: Vec<Pubkey> = chunk.iter().map(|a| Pubkey::new_from_array(*a)).collect();
            let response = state
                .rpc
                .get_multiple_accounts_with_commitment(&keys, state.rpc.commitment())
                .await
                .map_err(unreachable)?;
            slot = slot.min(response.context.slot);
            for (key, account) in keys.iter().zip(response.value) {
                if account
                    .is_some_and(|a| a.owner == program.id() && a.data.len() as u64 == RECORD_LEN)
                {
                    existing.insert(key.to_bytes());
                }
            }
        }
        let outcome = state
            .settlements
            .reconcile(&Read { slot, existing }, now)
            .map_err(io)?;
        report.settlements_forgotten += u32::try_from(outcome.forgotten).unwrap_or(u32::MAX);
    }

    // Close what is due, with the rent going back to the fee payer that paid it.
    let due = state.settlements.closable(now, CLOSE_BATCH);
    if !due.is_empty() {
        let fee_payer = state.fee_payer.pubkey();
        let pairs: Vec<(Pubkey, Pubkey)> = due
            .iter()
            .map(|address| (Pubkey::new_from_array(*address), fee_payer))
            .collect();
        let close = transactions::close_spent(&program, &pairs);
        if send_with_limit(state, &[close], CLOSE_COMPUTE_UNIT_LIMIT).await {
            state.settlements.closed(&due).map_err(io)?;
            report.settlements_closed += u32::try_from(due.len()).unwrap_or(u32::MAX);
            info!(
                records = due.len(),
                "returned the rent of settlement records"
            );
        } else {
            warn!("a settlement close did not land");
        }
    }

    // Adopt: every record the chain shows under the fee payer that the ledger does not know. The
    // slot is read first, so the answer is at least that new.
    let slot = state.rpc.get_slot().await.map_err(unreachable)?;
    let accounts = state
        .rpc
        .get_program_ui_accounts_with_config(
            &program.id(),
            RpcProgramAccountsConfig {
                filters: Some(vec![
                    RpcFilterType::DataSize(RECORD_LEN),
                    RpcFilterType::Memcmp(Memcmp::new_base58_encoded(0, &spent_discriminator())),
                    RpcFilterType::Memcmp(Memcmp::new_base58_encoded(
                        RECORD_PAYER_OFFSET,
                        state.fee_payer.pubkey().as_ref(),
                    )),
                ]),
                account_config: RpcAccountInfoConfig {
                    encoding: Some(solana_account_decoder_client_types::UiAccountEncoding::Base64),
                    // The expiry and the time the record may close.
                    data_slice: Some(UiDataSliceConfig {
                        offset: 72,
                        length: 8,
                    }),
                    commitment: Some(state.rpc.commitment()),
                    ..RpcAccountInfoConfig::default()
                },
                ..RpcProgramAccountsConfig::default()
            },
        )
        .await
        .map_err(unreachable)?;
    let found: Vec<Found> = accounts
        .into_iter()
        .filter_map(|(address, account)| {
            let account = account_of(account)?;
            Some(Found {
                address: address.to_bytes(),
                closable_at: u32::from_le_bytes(account.data.get(4..8)?.try_into().ok()?),
                lamports: account.lamports,
            })
        })
        .collect();
    let adopted = state.settlements.adopt(slot, &found).map_err(io)?;
    report.settlements_adopted += u32::try_from(adopted).unwrap_or(u32::MAX);
    Ok(())
}

/// Runs the janitor at start and then every `interval`.
pub fn spawn(state: Arc<Gateway>, interval: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match run_once(&state, ROTATION_GRACE).await {
                Ok(report) => info!(?report, "the janitor ran"),
                Err(_) => warn!("the janitor could not read Solana"),
            }
            tokio::time::sleep(interval).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(withdrawn: bool, bond_slashed: u64) -> Ledger {
        Ledger {
            discriminator: [0; 8],
            backing_left: 0,
            bond_free: 0,
            bond_slashed,
            payer: Pubkey::new_unique(),
            key: [2; 33],
            lock_seq: 0,
            withdrawn,
            bump: 255,
        }
    }

    fn lock(lock_until: u32) -> Lock {
        Lock {
            discriminator: [0; 8],
            mint: Pubkey::new_unique(),
            bond: 0,
            backing: 0,
            lock_until,
            bump: 255,
            escrow_bump: 255,
        }
    }

    const W: Windows = Windows::PRODUCTION;

    #[test]
    fn a_lock_is_released_when_the_release_delay_has_passed_and_closed_with_it_when_the_record_may_close()
     {
        let until = 1_000_000;
        let release_at = u64::from(until + W.claim_window + W.release_delay);
        assert_eq!(
            due(&ledger(false, 0), &lock(until), true, release_at - 1, &W),
            Due::Nothing
        );
        assert_eq!(
            due(&ledger(false, 0), &lock(until), true, release_at, &W),
            Due::Release { close: true },
            "the production windows open the close with the release"
        );
        // A lock the wallet withdrew leaves its records to close.
        assert_eq!(
            due(&ledger(true, 0), &lock(until), false, release_at, &W),
            Due::Close
        );
    }

    #[test]
    fn only_the_buffers_past_their_stale_time_are_closed() {
        let (fresh, stale) = (Pubkey::new_unique(), Pubkey::new_unique());
        let now = 10_000u64;
        let found = [
            (fresh, (now - u64::from(STALE_BUFFER_SECS) + 1) as u32),
            (stale, (now - u64::from(STALE_BUFFER_SECS)) as u32),
        ];
        assert_eq!(stale_buffers(&found, now), vec![stale]);
    }

    #[test]
    fn a_slash_still_in_the_pool_keeps_the_close_waiting() {
        let until = 1_000_000;
        let late = u64::from(until + W.record_ttl() + W.release_delay);
        assert_eq!(
            due(&ledger(false, 30), &lock(until), true, late, &W),
            Due::Release { close: false },
            "the release pays the rest and the close waits for the pool to be paid"
        );
        assert_eq!(
            due(&ledger(true, 30), &lock(until), false, late, &W),
            Due::Nothing
        );
    }

    #[test]
    fn nothing_is_due_before_the_windows_whatever_the_lock_looks_like() {
        let until = 1_000_000;
        for now in [0, u64::from(until), u64::from(until + W.claim_window)] {
            assert_eq!(
                due(&ledger(false, 0), &lock(until), true, now, &W),
                Due::Nothing
            );
            assert_eq!(
                due(&ledger(true, 0), &lock(until), false, now, &W),
                Due::Nothing
            );
        }
    }
}
