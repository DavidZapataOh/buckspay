//! The gateway's own record of what it has lent: the ledger, how it is written, and how it is
//! brought back in line with the chain. Nothing here names a person: counters are keyed by a
//! network prefix, by a short hash of a holder key, or by a lock address, in separate tables.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use super::{Caps, day_of};

/// A send that was written down before it was made, and may or may not have landed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Intent {
    /// The cluster slot when it was written down.
    pub sent_slot: u64,
    /// The second until which it may still land.
    pub until: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct Open {
    /// `None` for a record found on chain that the ledger had forgotten: it counts against the
    /// float, not against any lock.
    pub lock: Option<String>,
    pub issuer: Option<String>,
    pub lamports: u64,
    pub closable_at: u32,
    pub intent: Option<Intent>,
    /// The slot at which the record was last known to exist.
    pub seen_slot: Option<u64>,
    /// Reads, each at a later slot than the one before, that did not return it.
    pub missing: u8,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub(crate) struct Ledger {
    pub day: u64,
    pub requests_today: u32,
    pub unknown_sends: u64,
    pub failed_fees: u64,
    /// Records the gateway paid for and has not seen closed, by address.
    pub open: BTreeMap<String, Open>,
    pub networks: BTreeMap<String, BTreeMap<u64, u32>>,
    pub keys: BTreeMap<String, BTreeMap<u64, u32>>,
    pub locks: BTreeMap<String, BTreeMap<u64, u32>>,
    /// The slot of the newest confirmed read applied by `reconcile`, and by `adopt`: a read that
    /// is not newer is ignored, whatever replica it came from.
    pub reconciled_slot: u64,
    pub adopted_slot: u64,
}

/// What `getMultipleAccounts` returned for every address in the open set, at a confirmed
/// commitment, and the slot of its context.
pub struct Read {
    pub slot: u64,
    pub existing: HashSet<[u8; 32]>,
}

/// A record found on chain by its payer (`getProgramAccounts` with the size of a record and the
/// fee payer at offset 40 of its data), at a confirmed commitment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Found {
    pub address: [u8; 32],
    pub closable_at: u32,
    pub lamports: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// The read was not newer than one already applied: nothing changed.
    pub stale: bool,
    pub forgotten: usize,
}

impl Ledger {
    pub(crate) fn sweep(&mut self, now: u32) {
        let day = day_of(now);
        if self.day != day {
            self.day = day;
            self.requests_today = 0;
        }
        for table in [&mut self.networks, &mut self.keys, &mut self.locks] {
            for days in table.values_mut() {
                days.retain(|d, _| *d + 30 > day);
            }
            table.retain(|_, days| !days.is_empty());
        }
    }

    pub(crate) fn reconcile(&mut self, read: &Read, now: u32, caps: &Caps) -> Reconciled {
        if read.slot <= self.reconciled_slot {
            return Reconciled {
                stale: true,
                forgotten: 0,
            };
        }
        self.reconciled_slot = read.slot;
        let existing: HashSet<String> = read.existing.iter().map(hex::encode).collect();
        let before = self.open.len();
        self.open.retain(|address, open| {
            if existing.contains(address) {
                open.intent = None;
                open.seen_slot = Some(open.seen_slot.map_or(read.slot, |s| s.max(read.slot)));
                open.missing = 0;
                return true;
            }
            match open.intent {
                // It can still land until its blockhash is gone, and a read from before that
                // cannot say it did not.
                Some(i) => now < i.until || read.slot < i.sent_slot + caps.intent_slots,
                None => {
                    if open.seen_slot.is_some_and(|seen| read.slot < seen) {
                        return true;
                    }
                    // A record disappears before `closable_at` only if the read is wrong or the
                    // cluster reorganised: wait for several reads before believing it.
                    open.missing = open.missing.saturating_add(1);
                    now < open.closable_at && open.missing < caps.missing_reads
                }
            }
        });
        Reconciled {
            stale: false,
            forgotten: before - self.open.len(),
        }
    }

    pub(crate) fn adopt(&mut self, slot: u64, found: &[Found]) -> usize {
        if slot <= self.adopted_slot {
            return 0;
        }
        self.adopted_slot = slot;
        let mut adopted = 0;
        for record in found {
            self.open
                .entry(hex::encode(record.address))
                .or_insert_with(|| {
                    adopted += 1;
                    Open {
                        lock: None,
                        issuer: None,
                        lamports: record.lamports,
                        closable_at: record.closable_at,
                        intent: None,
                        seen_slot: Some(slot),
                        missing: 0,
                    }
                });
        }
        adopted
    }

    /// The records the janitor may try to close at `now`, oldest first. `margin` seconds past
    /// `closable_at` keep one record at the boundary, with the gateway's clock ahead of the
    /// cluster's, from making the whole batch revert.
    pub(crate) fn closable(&self, now: u32, margin: u32, limit: usize) -> Vec<[u8; 32]> {
        let mut due: Vec<(u32, [u8; 32])> = self
            .open
            .iter()
            .filter(|(_, open)| open.intent.is_none())
            .filter(|(_, open)| u64::from(open.closable_at) + u64::from(margin) <= u64::from(now))
            .filter_map(|(address, open)| Some((open.closable_at, hex_bytes(address)?)))
            .collect();
        due.sort_unstable();
        due.into_iter().take(limit).map(|(_, a)| a).collect()
    }
}

fn hex_bytes(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    if text.len() != 64 {
        return None;
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

/// The ledger file. A write goes to a temporary file of its own in the same directory, is synced,
/// replaces the ledger by rename and syncs the directory, so a power loss leaves the old ledger
/// or the new one, and two ledgers whose names share a stem never share a temporary file.
pub(crate) struct Store {
    path: PathBuf,
}

impl Store {
    pub(crate) fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
        }
    }

    pub(crate) fn load(&self) -> Result<Ledger, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Ledger::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(crate) fn save(&self, ledger: &Ledger) -> io::Result<()> {
        let dir = self
            .path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(&serde_json::to_vec(ledger).map_err(io::Error::other)?)?;
        file.as_file().sync_all()?;
        file.persist(&self.path).map_err(|e| e.error)?;
        fs::File::open(dir)?.sync_all()
    }
}
