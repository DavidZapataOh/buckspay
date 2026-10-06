//! What the gateway sponsors of the settlement and reclaim endpoints, and for how long. The float is the rent of the `Spent`
//! records the gateway paid and has not seen closed; it is lent, returned at `closable_at`, and
//! bounded here by a global cap, by a share per issuer lock that follows the lock's bond (and
//! nothing else: a lock without bond holds nothing), by the number of locks, by the life of the
//! record and by a minimum amount per record that climbs with the pressure.
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt, io,
    path::Path,
    sync::{Arc, Mutex},
};

mod ledger;
mod types;
pub use ledger::{Found, Read, Reconciled};
use ledger::{Intent, Ledger, Open, Store};
pub use types::*;

struct Pending {
    request: Request,
    expires_at: u32,
}

#[derive(Default)]
struct State {
    ledger: Ledger,
    pending: HashMap<u64, Pending>,
    next_id: u64,
    unwritable: bool,
}

pub struct SettlementLimits {
    caps: Caps,
    state: Mutex<State>,
    store: Option<Store>,
}

pub struct Reservation {
    limits: Arc<SettlementLimits>,
    id: u64,
    request: Request,
    priced: u32,
}

impl fmt::Debug for Reservation {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("Reservation").field("id", &self.id).finish()
    }
}

/// A send that has been written to the ledger and may be made. Dropping it, or crashing, leaves
/// the written intent: the janitor settles it against the chain.
pub struct Sending {
    limits: Arc<SettlementLimits>,
    addresses: Vec<[u8; 32]>,
}

impl fmt::Debug for Sending {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("Sending")
            .field("records", &self.addresses.len())
            .finish()
    }
}

fn day_of(now: u32) -> u64 {
    u64::from(now) / u64::from(DAY)
}

/// A holder key is a public key already, but the ledger keeps a short hash so that it holds
/// nothing that names a device.
fn key_id(key: &[u8; 33]) -> String {
    hex::encode(&Sha256::digest(key)[..8])
}

impl SettlementLimits {
    pub fn new(caps: Caps) -> Arc<Self> {
        Self::build(caps, Ledger::default(), None)
    }

    pub fn open(caps: Caps, path: &Path) -> Result<Arc<Self>, String> {
        let store = Store::new(path);
        let ledger = store.load()?;
        Ok(Self::build(caps, ledger, Some(store)))
    }

    fn build(caps: Caps, ledger: Ledger, store: Option<Store>) -> Arc<Self> {
        assert!(
            caps.horizon >= caps.record_ttl,
            "a record is closable at once only after record_ttl"
        );
        Arc::new(Self {
            caps,
            state: Mutex::new(State {
                ledger,
                ..State::default()
            }),
            store,
        })
    }

    /// Reserves what `request` needs, or says why not. Nothing is kept for a refusal.
    pub fn reserve(self: &Arc<Self>, request: Request) -> Result<Reservation, Refusal> {
        let priced = request.records.len() as u32;
        self.reserve_priced(request, priced)
    }

    /// Reserves one batch of a job that creates `priced` records in all: the smallest amount is
    /// the one for every record the job still has to create, not only this batch's.
    pub fn reserve_priced(
        self: &Arc<Self>,
        request: Request,
        priced: u32,
    ) -> Result<Reservation, Refusal> {
        let mut s = self.state.lock().unwrap();
        self.sweep(&mut s, request.now);
        let priced = priced.max(request.records.len() as u32);
        self.admit(&s, &request, request.bond, None, priced)?;
        let id = s.next_id;
        s.next_id += 1;
        let expires_at = request.now.saturating_add(self.caps.reservation_ttl);
        s.pending.insert(
            id,
            Pending {
                request: request.clone(),
                expires_at,
            },
        );
        Ok(Reservation {
            limits: Arc::clone(self),
            id,
            request,
            priced,
        })
    }

    /// Every limit, for `request` with the lock's `bond` as the gateway reads it now. `own` is the
    /// reservation being checked again before its send, which must not count against itself.
    fn admit(
        &self,
        s: &State,
        request: &Request,
        bond: u64,
        own: Option<u64>,
        priced: u32,
    ) -> Result<(), Refusal> {
        let c = &self.caps;
        if s.unwritable {
            return Err(Refusal::Unwritable);
        }
        let day = day_of(request.now);
        let others: Vec<&Pending> = s
            .pending
            .iter()
            .filter(|(id, _)| Some(**id) != own)
            .map(|(_, p)| p)
            .collect();
        if s.ledger.requests_today + others.len() as u32 >= c.daily_cap {
            return Err(Refusal::DailyCap);
        }
        let new = request.records.len() as u32;
        let per_record = self.pressure(s, own).min_amount;
        let required = if new == 0 {
            c.base_min_amount
        } else {
            per_record.saturating_mul(u64::from(priced))
        };
        if request.amount < required {
            return Err(Refusal::BelowMinimum(required));
        }
        if let Some(latest) = request.records.iter().map(|r| r.closable_at).max() {
            let allowed = u64::from(request.now) + u64::from(c.horizon);
            if u64::from(latest) > allowed {
                return Err(Refusal::Horizon {
                    retry_at: latest - c.horizon,
                });
            }
        }
        let mine = others
            .iter()
            .filter(|p| p.request.prefix == request.prefix)
            .count() as u32;
        if mine >= c.preparing_per_prefix {
            return Err(Refusal::PrefixBusy);
        }
        let (today, month) = counts(s.ledger.networks.get(&request.prefix.to_string()), day);
        if today + mine >= c.per_prefix_per_day {
            return Err(Refusal::PrefixSpentToday);
        }
        if month + mine >= c.per_prefix_per_30_days {
            return Err(Refusal::PrefixSpentThisMonth);
        }
        let key = key_id(&request.key);
        let mine = others
            .iter()
            .filter(|p| key_id(&p.request.key) == key)
            .count() as u32;
        let (today, month) = counts(s.ledger.keys.get(&key), day);
        if today + mine >= c.per_key_per_day {
            return Err(Refusal::KeySpentToday);
        }
        if month + mine >= c.per_key_per_30_days {
            return Err(Refusal::KeySpentThisMonth);
        }
        let lock = hex::encode(request.lock);
        let mine = others
            .iter()
            .filter(|p| p.request.lock == request.lock)
            .count() as u32;
        let (today, _) = counts(s.ledger.locks.get(&lock), day);
        if today + mine >= c.per_lock_per_day {
            return Err(Refusal::LockSpentToday);
        }
        self.admit_lock(s, request, bond, &others)?;
        let open_float: u64 = s.ledger.open.values().map(|o| o.lamports).sum();
        let reserved_float: u64 = others
            .iter()
            .map(|p| p.request.rent * p.request.records.len() as u64)
            .sum();
        if open_float + reserved_float + request.rent * u64::from(new) > c.float_cap {
            return Err(Refusal::FloatCap);
        }
        Ok(())
    }

    /// The share of the lock and the number of locks.
    fn admit_lock(
        &self,
        s: &State,
        request: &Request,
        bond: u64,
        others: &[&Pending],
    ) -> Result<(), Refusal> {
        let c = &self.caps;
        let new = request.records.len() as u32;
        let lock = hex::encode(request.lock);
        let issuer = hex::encode(request.issuer);
        let allowed = self.lock_share(bond, request.rent);
        let open_of_lock = s
            .ledger
            .open
            .values()
            .filter(|o| o.lock.as_deref() == Some(&lock))
            .count() as u32;
        let reserved_of_lock: u32 = others
            .iter()
            .filter(|p| p.request.lock == request.lock)
            .map(|p| p.request.records.len() as u32)
            .sum();
        if open_of_lock + reserved_of_lock + new > allowed {
            return Err(Refusal::LockShare { allowed });
        }
        let mut locks: HashSet<&str> = s
            .ledger
            .open
            .values()
            .filter_map(|o| o.lock.as_deref())
            .collect();
        let reserved: Vec<String> = others.iter().map(|p| hex::encode(p.request.lock)).collect();
        locks.extend(reserved.iter().map(String::as_str));
        let known = locks.contains(lock.as_str());
        if !known && locks.len() as u32 >= c.max_locks {
            return Err(Refusal::TooManyLocks);
        }
        let mut of_issuer: HashSet<&str> = s
            .ledger
            .open
            .values()
            .filter(|o| o.issuer.as_deref() == Some(&issuer))
            .filter_map(|o| o.lock.as_deref())
            .collect();
        let reserved_of_issuer: Vec<String> = others
            .iter()
            .filter(|p| p.request.issuer == request.issuer)
            .map(|p| hex::encode(p.request.lock))
            .collect();
        of_issuer.extend(reserved_of_issuer.iter().map(String::as_str));
        if !of_issuer.contains(lock.as_str()) && of_issuer.len() as u32 >= c.max_locks_per_issuer {
            return Err(Refusal::IssuerLocks);
        }
        Ok(())
    }

    /// Open records a lock with this bond may hold: none below `min_bond`, then one for every
    /// `bond_per_record` of bond, never more than `per_lock_max_percent` of the cap.
    pub fn lock_share(&self, bond: u64, rent: u64) -> u32 {
        let c = &self.caps;
        if bond < c.min_bond {
            return 0;
        }
        let by_bond = bond.checked_div(c.bond_per_record).unwrap_or(0);
        let cap_records = c.float_cap.checked_div(rent).unwrap_or(0);
        let ceiling = cap_records * u64::from(c.per_lock_max_percent) / 100;
        u32::try_from(by_bond.min(ceiling)).unwrap_or(u32::MAX)
    }

    /// The smallest sponsored amount per new record in force and the pressure it follows. Costs
    /// no reservation.
    pub fn status(&self, now: u32) -> Status {
        let mut s = self.state.lock().unwrap();
        self.sweep(&mut s, now);
        self.pressure(&s, None)
    }

    fn pressure(&self, s: &State, own: Option<u64>) -> Status {
        let pending = || {
            s.pending
                .iter()
                .filter(move |(id, _)| Some(**id) != own)
                .map(|(_, p)| p)
        };
        let reserved: u64 = pending()
            .map(|p| p.request.rent * p.request.records.len() as u64)
            .sum();
        let open_float: u64 = s.ledger.open.values().map(|o| o.lamports).sum::<u64>() + reserved;
        let by_float = u128::from(open_float) * 100 / u128::from(self.caps.float_cap.max(1));
        let by_day = u128::from(s.ledger.requests_today + pending().count() as u32) * 100
            / u128::from(self.caps.daily_cap.max(1));
        let pressure_percent = u8::try_from(by_float.max(by_day).min(100)).unwrap_or(100);
        let min_amount = self
            .caps
            .steps
            .iter()
            .filter(|step| pressure_percent >= step.at_percent)
            .map(|step| step.min_amount)
            .fold(self.caps.record_min_amount, u64::max);
        let locks: HashSet<&str> = s
            .ledger
            .open
            .values()
            .filter_map(|o| o.lock.as_deref())
            .collect();
        Status {
            pressure_percent,
            min_amount,
            open_records: s.ledger.open.len(),
            open_float,
            locks: locks.len(),
        }
    }

    /// Janitor: these records were seen closed on chain.
    pub fn closed(&self, addresses: &[[u8; 32]]) -> io::Result<()> {
        let mut s = self.state.lock().unwrap();
        for a in addresses {
            s.ledger.open.remove(&hex::encode(a));
        }
        self.write(&mut s)
    }

    /// Janitor: the records to put in the next `close_spent` batch, oldest first. A record is due
    /// `close_margin` seconds after `closable_at`, so that a gateway clock ahead of the cluster's
    /// does not make the whole batch revert with `RecordNotClosable`.
    pub fn closable(&self, now: u32, limit: usize) -> Vec<[u8; 32]> {
        let s = self.state.lock().unwrap();
        s.ledger.closable(now, self.caps.close_margin, limit)
    }

    /// Janitor: brings the open set in line with a confirmed read of the chain. Idempotent: a read
    /// that is not newer than one already applied changes nothing, so a lagging replica cannot
    /// make the ledger forget a record it has seen; a landed record is forgotten only after
    /// `missing_reads` newer reads lack it (or once it was due to close), a written-down send only
    /// after its blockhash is gone.
    pub fn reconcile(&self, read: &Read, now: u32) -> io::Result<Reconciled> {
        let mut s = self.state.lock().unwrap();
        let outcome = s.ledger.reconcile(read, now, &self.caps);
        self.write(&mut s)?;
        Ok(outcome)
    }

    /// Janitor, from `getProgramAccounts` filtered on the record size and on the fee payer: every
    /// record the gateway paid for that its ledger does not know (a lost file, a crash that
    /// predates the write-ahead, a send recorded as failed that landed) is adopted, so that it is
    /// counted and closed. Returns how many were adopted.
    pub fn adopt(&self, slot: u64, found: &[Found]) -> io::Result<usize> {
        let mut s = self.state.lock().unwrap();
        let adopted = s.ledger.adopt(slot, found);
        self.write(&mut s)?;
        Ok(adopted)
    }

    /// The addresses of every record the ledger holds open, for the janitor's reads of the chain.
    pub fn open_addresses(&self) -> Vec<[u8; 32]> {
        let s = self.state.lock().unwrap();
        s.ledger
            .open
            .keys()
            .filter_map(|address| hex::decode(address).ok()?.try_into().ok())
            .collect()
    }

    /// When the soonest open record may close, never before `now`: the time from which a refused
    /// request may be tried again.
    pub fn next_closable(&self, now: u32) -> Option<u32> {
        let s = self.state.lock().unwrap();
        s.ledger
            .open
            .values()
            .map(|open| open.closable_at.max(now))
            .min()
    }

    pub fn open_records(&self) -> usize {
        self.state.lock().unwrap().ledger.open.len()
    }
    pub fn open_of_lock(&self, lock: &[u8; 32]) -> usize {
        let lock = hex::encode(lock);
        self.state
            .lock()
            .unwrap()
            .ledger
            .open
            .values()
            .filter(|o| o.lock.as_deref() == Some(&lock))
            .count()
    }
    pub fn unknown_sends(&self) -> u64 {
        self.state.lock().unwrap().ledger.unknown_sends
    }
    pub fn failed_fees(&self) -> u64 {
        self.state.lock().unwrap().ledger.failed_fees
    }
    pub fn pending(&self) -> usize {
        self.state.lock().unwrap().pending.len()
    }
    pub fn sponsored_by_prefix(&self, prefix: Prefix, now: u32) -> u32 {
        let s = self.state.lock().unwrap();
        counts(s.ledger.networks.get(&prefix.to_string()), day_of(now)).0
    }
    /// Number of rows in the counter tables, to show that sweeping bounds them.
    pub fn counter_rows(&self) -> usize {
        let s = self.state.lock().unwrap();
        let l = &s.ledger;
        l.networks
            .values()
            .chain(l.keys.values())
            .chain(l.locks.values())
            .map(BTreeMap::len)
            .sum()
    }

    /// Drops what has expired: reservations after their time to live, counter days after 30,
    /// and rolls the day.
    fn sweep(&self, s: &mut State, now: u32) {
        s.pending.retain(|_, p| p.expires_at > now);
        s.ledger.sweep(now);
    }

    fn write(&self, s: &mut State) -> io::Result<()> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let result = store.save(&s.ledger);
        if result.is_err() {
            s.unwritable = true;
        }
        result
    }
}

/// Today's count and the count over the 30 days ending today.
fn counts(days: Option<&BTreeMap<u64, u32>>, day: u64) -> (u32, u32) {
    days.map_or((0, 0), |d| {
        (
            d.get(&day).copied().unwrap_or(0),
            d.iter()
                .filter(|(k, _)| **k + 30 > day)
                .map(|(_, v)| v)
                .sum(),
        )
    })
}

impl Reservation {
    /// Immediately before the transaction is sent, with the lock's bond as the gateway reads it
    /// now and the cluster's slot: every limit is checked again, and the send is **written down
    /// before it is made**. It counts against the network that prepared it, the key, the lock and
    /// the day, and its records are open with an intent that the janitor resolves. If the
    /// reservation was swept, a limit no longer holds or the ledger cannot be written, nothing is
    /// sent.
    pub fn begin(self, now: u32, slot: u64, bond: u64) -> Result<Sending, Refusal> {
        let limits = Arc::clone(&self.limits);
        let mut s = limits.state.lock().unwrap();
        limits.sweep(&mut s, now);
        if !s.pending.contains_key(&self.id) {
            return Err(Refusal::Expired);
        }
        limits.admit(&s, &self.request, bond, Some(self.id), self.priced)?;
        s.pending.remove(&self.id);
        let backup = s.ledger.clone();
        let r = &self.request;
        let day = day_of(r.now);
        let ledger = &mut s.ledger;
        ledger.requests_today += 1;
        for (table, key) in [
            (&mut ledger.networks, r.prefix.to_string()),
            (&mut ledger.keys, key_id(&r.key)),
            (&mut ledger.locks, hex::encode(r.lock)),
        ] {
            *table.entry(key).or_default().entry(day).or_insert(0) += 1;
        }
        let intent = Intent {
            sent_slot: slot,
            until: now.saturating_add(limits.caps.unknown_grace),
        };
        for record in &r.records {
            s.ledger.open.insert(
                hex::encode(record.address),
                Open {
                    lock: Some(hex::encode(r.lock)),
                    issuer: Some(hex::encode(r.issuer)),
                    lamports: r.rent,
                    closable_at: record.closable_at,
                    intent: Some(intent),
                    seen_slot: None,
                    missing: 0,
                },
            );
        }
        if limits.write(&mut s).is_err() {
            s.ledger = backup;
            return Err(Refusal::Unwritable);
        }
        Ok(Sending {
            limits: Arc::clone(&limits),
            addresses: r.records.iter().map(|r| r.address).collect(),
        })
    }
}

impl Sending {
    /// The transaction landed, confirmed at `slot`: the records exist from then on.
    pub fn landed(self, slot: u64) -> io::Result<()> {
        let mut s = self.limits.state.lock().unwrap();
        for address in &self.addresses {
            if let Some(open) = s.ledger.open.get_mut(&hex::encode(address)) {
                open.intent = None;
                open.seen_slot = Some(slot);
            }
        }
        self.limits.write(&mut s)
    }

    /// The outcome is unknown (an RPC error that is not a transaction error, a dropped or
    /// unconfirmed transaction): it may still land, so it stays counted and its records stay
    /// open until the janitor sees the chain without them after the blockhash is gone.
    pub fn unknown(self) -> io::Result<()> {
        let mut s = self.limits.state.lock().unwrap();
        s.ledger.unknown_sends += 1;
        self.limits.write(&mut s)
    }

    /// The transaction landed and failed: the sponsor paid `fee`, no record exists, and the
    /// attempt still counts against the limits.
    pub fn failed(self, fee: u64) -> io::Result<()> {
        let mut s = self.limits.state.lock().unwrap();
        for address in &self.addresses {
            s.ledger.open.remove(&hex::encode(address));
        }
        s.ledger.failed_fees += fee;
        self.limits.write(&mut s)
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        // A reservation that was refused or never began is released.
        if let Ok(mut s) = self.limits.state.lock() {
            s.pending.remove(&self.id);
        }
    }
}
