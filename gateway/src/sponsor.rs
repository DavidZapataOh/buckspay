//! What the gateway lets itself spend on behalf of users, and the state that survives a restart.
//!
//! Two budgets bound the sponsor, because its outlay has two natures. The permanent cost of an
//! onboarding (the device account's rent and the fees) is spent for good and is charged against
//! the CAC budget. The rent of a lock's accounts and of a pending rotation is lent: it comes back
//! when the lock is released and closed or the rotation is applied or cancelled, and what is out
//! at once is bounded by the open-rent cap. Per-network counts, a daily cap and a minimum funding
//! that climbs with the load bound the rate at which either grows.
pub use crate::limits::Prefix;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug)]
pub struct Caps {
    /// Lamports of permanent cost the gateway will spend in total.
    pub cac_budget: u64,
    /// Lamports of rent lent out at once: open locks, pending rotations and what is being prepared.
    pub open_rent_cap: u64,
    pub daily_onboardings: u32,
    pub per_prefix_per_day: u32,
    pub per_prefix_per_30_days: u32,
    pub preparing_per_prefix: u32,
    pub escalation: Escalation,
}

/// Who pays the cost of onboarding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeeMode {
    /// The sponsor absorbs it.
    Off,
    /// The wallet pays the sponsor's cost plus a margin, as the first lock's `sponsor_fee`.
    CostPlus,
}

/// From `at_percent` of pressure on, the minimum sponsored funding is `min_funding`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub at_percent: u8,
    pub min_funding: u64,
}

/// The automatic response to load: the minimum funding climbs a ladder and the fee lever switches
/// to `cost_plus`. Pressure is the larger of the open-rent use and the day's onboardings use, in
/// percent.
#[derive(Clone, Debug)]
pub struct Escalation {
    pub base_min_funding: u64,
    /// Ascending in `at_percent`; the highest step reached applies.
    pub steps: Vec<Step>,
    /// Pressure at which the fee lever is forced to `cost_plus`.
    pub fee_on_percent: u8,
    /// Pressure below which a forced fee lever is released again (hysteresis).
    pub fee_off_percent: u8,
}

impl Default for Escalation {
    /// The pilot's values, in base units of a 6-decimal token.
    fn default() -> Self {
        Self {
            base_min_funding: 2_000_000,
            steps: vec![
                Step {
                    at_percent: 50,
                    min_funding: 5_000_000,
                },
                Step {
                    at_percent: 65,
                    min_funding: 10_000_000,
                },
                Step {
                    at_percent: 80,
                    min_funding: 25_000_000,
                },
                Step {
                    at_percent: 90,
                    min_funding: 50_000_000,
                },
            ],
            fee_on_percent: 50,
            fee_off_percent: 40,
        }
    }
}

/// What the gateway quotes and enforces right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub pressure_percent: u8,
    pub min_funding: u64,
    pub fee_mode: FeeMode,
}

/// What one sponsored operation costs, read from the live rent when it is prepared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Costs {
    /// Spent for good (rent of the device account plus fees): charged against the CAC budget.
    pub permanent: u64,
    /// Lent and returned at close (rents of the lock, ledger and escrow): charged against the
    /// open-rent cap.
    pub float: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Registration and first lock in one transaction: permanent cost and float.
    Onboard,
    /// A later lock of a registered key: float only.
    Lock,
    /// A rotation request, which lends the rent of its `Rotation` account (the amount) until it is
    /// applied or cancelled.
    Rotation(u64),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    PrefixBusy,
    PrefixSpentToday,
    PrefixSpentThisMonth,
    DailyCap,
    CacBudget,
    OpenRentCap,
    /// The funding is below the current minimum, which is carried so the app can show it.
    BelowMinimum(u64),
    /// The ledger could not be written: nothing more is sponsored until a restart.
    Unwritable,
}

/// What survives a restart: counts and sums, with no wallet, device key or time of day.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
struct Ledger {
    cac_spent: u64,
    open_locks: u64,
    /// Lamports of rent lent in pending rotations.
    rotation_float: u64,
    /// Sends whose outcome Solana never reported; counted as sent.
    unknown_sends: u64,
    day: u64,
    onboardings_today: u32,
    /// prefix -> day number -> sponsored operations, pruned after 30 days. A ledger of the
    /// registration-only gateway has networks of another shape, which are dropped.
    #[serde(deserialize_with = "networks")]
    networks: BTreeMap<String, BTreeMap<u64, u32>>,
}

fn networks<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, BTreeMap<u64, u32>>, D::Error> {
    let raw = BTreeMap::<String, serde_json::Value>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|(network, days)| Some((network, serde_json::from_value(days).ok()?)))
        .collect())
}

#[derive(Default)]
struct State {
    ledger: Ledger,
    preparing: HashMap<Prefix, u32>,
    reserved_cac: u64,
    reserved_float: u64,
    reserved_onboardings: u32,
    unwritable: bool,
    fee_forced: bool,
}

pub struct SponsorLimits {
    caps: Caps,
    state: Mutex<State>,
    path: Option<PathBuf>,
}

/// An operation being prepared. It counts against the caps of the network that prepared it until
/// it is dropped, committed, failed or marked unknown.
pub struct Reservation {
    limits: Arc<SponsorLimits>,
    prefix: Prefix,
    kind: Kind,
    costs: Costs,
    day: u64,
}

impl SponsorLimits {
    /// Limits kept in memory only.
    pub fn new(caps: Caps) -> Arc<Self> {
        Arc::new(Self {
            caps,
            state: Mutex::default(),
            path: None,
        })
    }

    /// Limits whose counts are kept in `path`, read back if it exists.
    pub fn open(caps: Caps, path: &Path) -> Result<Arc<Self>, String> {
        let ledger = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| format!("{} is not a sponsorship ledger", path.display()))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ledger::default(),
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        Ok(Arc::new(Self {
            caps,
            state: Mutex::new(State {
                ledger,
                ..State::default()
            }),
            path: Some(path.to_owned()),
        }))
    }

    /// Reserves an operation for `prefix` if every cap allows it, in one step, so that concurrent
    /// requests cannot all pass the checks before any of them counts. `funding` is `bond + backing`
    /// of the lock being sponsored; below the minimum in force nothing is reserved.
    pub fn reserve(
        self: &Arc<Self>,
        prefix: Prefix,
        kind: Kind,
        costs: Costs,
        day: u64,
        funding: u64,
    ) -> Result<Reservation, Refusal> {
        let mut state = self.state.lock().unwrap();
        self.roll(&mut state, day);
        let caps = &self.caps;
        if state.unwritable {
            return Err(Refusal::Unwritable);
        }
        if !matches!(kind, Kind::Rotation(_)) {
            let min_funding = self.assess(&mut state, costs).min_funding;
            if funding < min_funding {
                return Err(Refusal::BelowMinimum(min_funding));
            }
        }
        let mine = state.preparing.get(&prefix).copied().unwrap_or(0);
        if mine >= caps.preparing_per_prefix {
            return Err(Refusal::PrefixBusy);
        }
        let by_day = state.ledger.networks.get(&prefix.to_string());
        let today = by_day.and_then(|d| d.get(&day)).copied().unwrap_or(0);
        let month: u32 = by_day.map_or(0, |d| d.values().sum());
        if today.saturating_add(mine) >= caps.per_prefix_per_day {
            return Err(Refusal::PrefixSpentToday);
        }
        if month.saturating_add(mine) >= caps.per_prefix_per_30_days {
            return Err(Refusal::PrefixSpentThisMonth);
        }
        if kind == Kind::Onboard {
            if state
                .ledger
                .onboardings_today
                .saturating_add(state.reserved_onboardings)
                >= caps.daily_onboardings
            {
                return Err(Refusal::DailyCap);
            }
            let spent = state
                .ledger
                .cac_spent
                .saturating_add(state.reserved_cac)
                .saturating_add(costs.permanent);
            if spent > caps.cac_budget {
                return Err(Refusal::CacBudget);
            }
        }
        let float = float_of(kind, costs);
        if self.open_rent(&state, costs).saturating_add(float) > caps.open_rent_cap {
            return Err(Refusal::OpenRentCap);
        }
        *state.preparing.entry(prefix).or_insert(0) += 1;
        state.reserved_float = state.reserved_float.saturating_add(float);
        if kind == Kind::Onboard {
            state.reserved_cac = state.reserved_cac.saturating_add(costs.permanent);
            state.reserved_onboardings += 1;
        }
        Ok(Reservation {
            limits: Arc::clone(self),
            prefix,
            kind,
            costs,
            day,
        })
    }

    /// The minimum funding and the fee mode in force. `configured` is the operator's setting, which
    /// the escalation can raise but never lower.
    pub fn status(&self, configured: FeeMode, costs: Costs, day: u64) -> Status {
        let mut state = self.state.lock().unwrap();
        self.roll(&mut state, day);
        let mut status = self.assess(&mut state, costs);
        if configured == FeeMode::CostPlus {
            status.fee_mode = FeeMode::CostPlus;
        }
        status
    }

    fn open_rent(&self, state: &State, costs: Costs) -> u64 {
        state
            .ledger
            .open_locks
            .saturating_mul(costs.float)
            .saturating_add(state.ledger.rotation_float)
            .saturating_add(state.reserved_float)
    }

    fn assess(&self, state: &mut State, costs: Costs) -> Status {
        let escalation = &self.caps.escalation;
        let percent = |used: u64, cap: u64| {
            u128::from(used)
                .saturating_mul(100)
                .checked_div(u128::from(cap))
                .map_or(100, |p| u8::try_from(p.min(100)).unwrap_or(100))
        };
        let today = state
            .ledger
            .onboardings_today
            .saturating_add(state.reserved_onboardings);
        let pressure_percent = percent(self.open_rent(state, costs), self.caps.open_rent_cap).max(
            percent(u64::from(today), u64::from(self.caps.daily_onboardings)),
        );
        let min_funding = escalation
            .steps
            .iter()
            .filter(|step| pressure_percent >= step.at_percent)
            .map(|step| step.min_funding)
            .fold(escalation.base_min_funding, u64::max);
        if pressure_percent >= escalation.fee_on_percent {
            state.fee_forced = true;
        } else if pressure_percent < escalation.fee_off_percent {
            state.fee_forced = false;
        }
        Status {
            pressure_percent,
            min_funding,
            fee_mode: if state.fee_forced {
                FeeMode::CostPlus
            } else {
                FeeMode::Off
            },
        }
    }

    /// The janitor saw `n` locks closed.
    pub fn closed(&self, n: u64) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        state.ledger.open_locks = state.ledger.open_locks.saturating_sub(n);
        self.write(&mut state)
    }

    /// The janitor read the chain, which is the truth: `count` ledgers have the gateway as payer.
    pub fn reconcile_open_locks(&self, count: u64) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        state.ledger.open_locks = count;
        self.write(&mut state)
    }

    /// The janitor read the chain: `lamports` of rotation rent are lent.
    pub fn reconcile_rotation_float(&self, lamports: u64) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        state.ledger.rotation_float = lamports;
        self.write(&mut state)
    }

    pub fn open_locks(&self) -> u64 {
        self.state.lock().unwrap().ledger.open_locks
    }

    pub fn unknown_sends(&self) -> u64 {
        self.state.lock().unwrap().ledger.unknown_sends
    }

    pub fn cac_spent(&self) -> u64 {
        self.state.lock().unwrap().ledger.cac_spent
    }

    pub fn rotation_float(&self) -> u64 {
        self.state.lock().unwrap().ledger.rotation_float
    }

    /// Operations being prepared.
    pub fn preparing(&self) -> u32 {
        self.state.lock().unwrap().preparing.values().sum()
    }

    pub fn sponsored_by(&self, prefix: Prefix, day: u64) -> u32 {
        let state = self.state.lock().unwrap();
        state
            .ledger
            .networks
            .get(&prefix.to_string())
            .and_then(|days| days.get(&day))
            .copied()
            .unwrap_or(0)
    }

    /// Starts `day` if it is new and forgets the networks' counts older than 30 days.
    fn roll(&self, state: &mut State, day: u64) {
        if state.ledger.day != day {
            state.ledger.day = day;
            state.ledger.onboardings_today = 0;
        }
        for days in state.ledger.networks.values_mut() {
            days.retain(|d, _| d.saturating_add(30) > day);
        }
        state.ledger.networks.retain(|_, days| !days.is_empty());
    }

    fn write(&self, state: &mut State) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let written = write_atomically(path, &serde_json::to_vec(&state.ledger).unwrap());
        if written.is_err() {
            state.unwritable = true;
        }
        written
    }
}

fn float_of(kind: Kind, costs: Costs) -> u64 {
    match kind {
        Kind::Rotation(rent) => rent,
        Kind::Onboard | Kind::Lock => costs.float,
    }
}

/// Replaces `path` with `bytes` so that a crash leaves either the old or the new file.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    // The rename is durable once the directory is.
    fs::File::open(path.parent().unwrap())?.sync_all()
}

impl Reservation {
    /// The transaction was sent: charged to the network that *prepared* it, whatever network
    /// submits.
    pub fn commit(self) -> io::Result<()> {
        self.charge_as_sent(false)
    }

    /// The send's outcome is unknown (an RPC error that is not a transaction error, a dropped or
    /// unconfirmed transaction): it may still land, so it is counted exactly as a sent one. The
    /// janitor's reconcile removes the open lock if the chain never shows it.
    pub fn unknown(self) -> io::Result<()> {
        self.charge_as_sent(true)
    }

    fn charge_as_sent(self, unknown: bool) -> io::Result<()> {
        let limits = Arc::clone(&self.limits);
        let mut state = limits.state.lock().unwrap();
        limits.roll(&mut state, self.day);
        match self.kind {
            Kind::Onboard => {
                state.ledger.open_locks += 1;
                state.ledger.cac_spent =
                    state.ledger.cac_spent.saturating_add(self.costs.permanent);
                state.ledger.onboardings_today += 1;
            }
            Kind::Lock => state.ledger.open_locks += 1,
            Kind::Rotation(rent) => {
                state.ledger.rotation_float = state.ledger.rotation_float.saturating_add(rent);
            }
        }
        if unknown {
            state.ledger.unknown_sends += 1;
        }
        self.count_for_network(&mut state);
        limits.write(&mut state)
    }

    /// The transaction was sent and failed on chain (for example the wallet moved its tokens): the
    /// sponsor paid only `fee`. It still counts against the preparing network's day and the CAC
    /// budget.
    pub fn failed(self, fee: u64) -> io::Result<()> {
        let limits = Arc::clone(&self.limits);
        let mut state = limits.state.lock().unwrap();
        limits.roll(&mut state, self.day);
        state.ledger.cac_spent = state.ledger.cac_spent.saturating_add(fee);
        self.count_for_network(&mut state);
        limits.write(&mut state)
    }

    fn count_for_network(&self, state: &mut State) {
        *state
            .ledger
            .networks
            .entry(self.prefix.to_string())
            .or_default()
            .entry(self.day)
            .or_insert(0) += 1;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut state = self.limits.state.lock().unwrap();
        if let Some(count) = state.preparing.get_mut(&self.prefix) {
            *count -= 1;
            if *count == 0 {
                state.preparing.remove(&self.prefix);
            }
        }
        state.reserved_float = state
            .reserved_float
            .saturating_sub(float_of(self.kind, self.costs));
        if self.kind == Kind::Onboard {
            state.reserved_cac = state.reserved_cac.saturating_sub(self.costs.permanent);
            state.reserved_onboardings = state.reserved_onboardings.saturating_sub(1);
        }
    }
}

/// The fee of the `cost_plus` lever in base units of a 6-decimal token, rounded up to a multiple of
/// `step`. `price_micro_per_sol` is micro-tokens per SOL, `markup_percent` 110 for a 10% margin.
/// `None` when the result does not fit a `u64`: the gateway then refuses to quote a fee.
pub fn cost_plus_fee(
    permanent_lamports: u64,
    markup_percent: u64,
    price_micro_per_sol: u64,
    step: u64,
) -> Option<u64> {
    let marked = u128::from(permanent_lamports).checked_mul(u128::from(markup_percent))? / 100;
    let exact = marked
        .checked_mul(u128::from(price_micro_per_sol))?
        .div_ceil(1_000_000_000);
    let step = u128::from(step);
    u64::try_from(exact.div_ceil(step).checked_mul(step)?).ok()
}
