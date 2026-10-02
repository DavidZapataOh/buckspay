use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fmt, fs,
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The network a request comes from: its /24 for IPv4 and its /64 for IPv6, the blocks one
/// subscriber usually holds, so that rotating addresses inside them does not reset a limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Prefix {
    V4([u8; 3]),
    V6([u8; 8]),
}

impl From<IpAddr> for Prefix {
    fn from(ip: IpAddr) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(v4) => Self::V4(v4.octets()[..3].try_into().unwrap()),
            IpAddr::V6(v6) => Self::V6(v6.octets()[..8].try_into().unwrap()),
        }
    }
}

impl fmt::Display for Prefix {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::V4([a, b, c]) => write!(f, "{}/24", Ipv4Addr::new(*a, *b, *c, 0)),
            Self::V6(head) => {
                let mut octets = [0; 16];
                octets[..8].copy_from_slice(head);
                write!(f, "{}/64", Ipv6Addr::from(octets))
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Caps {
    /// Requests per minute from one prefix, to every endpoint but `/health`.
    pub requests_per_minute: NonZeroU32,
    /// Sponsored registrations from one prefix per `window`, those being prepared included.
    pub per_prefix: u32,
    /// Registrations one prefix may be preparing at once.
    pub preparing_per_prefix: u32,
    /// The fixed periods `per_prefix` counts in, aligned to the Unix epoch.
    pub window: Duration,
    /// Sponsored registrations not yet recovered from their wallets, plus those being prepared.
    pub outstanding: u64,
}

#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// Too many requests from this prefix: try again later.
    RateLimited,
    /// This prefix is preparing as many registrations as it may at once.
    PrefixBusy,
    /// This prefix used its sponsored registrations for the window.
    PrefixSpent,
    /// The sponsor's budget of unrecovered registrations is used up, or its ledger cannot be
    /// written.
    BudgetSpent,
}

/// What survives a restart: the unrecovered sponsorships, and the sponsorships of each network
/// in the current period. Nothing else: no address, wallet, key or time of day.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
struct Ledger {
    outstanding: u64,
    networks: BTreeMap<String, Window>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct Window {
    /// The period's number: Unix seconds divided by the window's length.
    period: u64,
    count: u32,
}

#[derive(Default)]
struct State {
    ledger: Ledger,
    /// Registrations being prepared, by prefix.
    preparing: HashMap<Prefix, u32>,
    /// Set once the ledger could not be written: nothing more is sponsored until a restart.
    unwritable: bool,
}

/// Rate limits and sponsorship caps. The outstanding count only grows here: a sponsored
/// registration is recovered through the fee of the wallet's first sponsored deposit.
pub struct Limits {
    caps: Caps,
    requests: DefaultKeyedRateLimiter<Prefix>,
    /// When the rate limiter last forgot the networks whose quota had refilled.
    swept: Mutex<Instant>,
    state: Mutex<State>,
    path: Option<PathBuf>,
}

/// A sponsored registration being prepared. It counts against the caps of the prefix that
/// prepared it until it is dropped; `sponsored` records it as sent, charged to that prefix.
pub struct Reservation {
    limits: Arc<Limits>,
    prefix: Prefix,
}

impl Reservation {
    /// Records the registration as sent and writes the ledger if it has a file.
    pub fn sponsored(self) -> io::Result<()> {
        self.limits.record(self.prefix)
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
    }
}

impl Limits {
    /// Limits kept in memory only.
    pub fn new(caps: Caps) -> Self {
        Self {
            caps,
            requests: RateLimiter::keyed(Quota::per_minute(caps.requests_per_minute)),
            swept: Mutex::new(Instant::now()),
            state: Mutex::default(),
            path: None,
        }
    }

    /// Limits whose sponsorship counts are kept in `path`, read back if it exists.
    pub fn open(caps: Caps, path: &Path) -> Result<Self, String> {
        let ledger = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| format!("{} is not a sponsorship ledger", path.display()))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ledger::default(),
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        let limits = Self {
            state: Mutex::new(State {
                ledger,
                ..State::default()
            }),
            path: Some(path.to_owned()),
            ..Self::new(caps)
        };
        limits.prune(&mut limits.state.lock().unwrap());
        Ok(limits)
    }

    /// Counts one request from `prefix`. Once a minute, the networks whose quota has refilled are
    /// forgotten: the rate limiter keeps no network longer than its quota needs it.
    pub fn request(&self, prefix: Prefix) -> Result<(), Refusal> {
        let mut swept = self.swept.lock().unwrap();
        if swept.elapsed() >= Duration::from_secs(60) {
            self.requests.retain_recent();
            *swept = Instant::now();
        }
        drop(swept);
        self.requests
            .check_key(&prefix)
            .map_err(|_| Refusal::RateLimited)
    }

    /// Whether `prefix` may prepare another sponsored registration now.
    pub fn may_sponsor(&self, prefix: Prefix) -> Result<(), Refusal> {
        let mut state = self.state.lock().unwrap();
        self.prune(&mut state);
        self.check(&state, prefix)
    }

    /// Reserves a sponsored registration for `prefix` if the caps allow one, in one step, so that
    /// concurrent requests cannot all pass the check before any of them counts.
    pub fn reserve(limits: &Arc<Self>, prefix: Prefix) -> Result<Reservation, Refusal> {
        let mut state = limits.state.lock().unwrap();
        limits.prune(&mut state);
        limits.check(&state, prefix)?;
        *state.preparing.entry(prefix).or_default() += 1;
        Ok(Reservation {
            limits: limits.clone(),
            prefix,
        })
    }

    /// Registrations being prepared.
    pub fn preparing(&self) -> u64 {
        let state = self.state.lock().unwrap();
        state
            .preparing
            .values()
            .map(|&count| u64::from(count))
            .sum()
    }

    fn check(&self, state: &State, prefix: Prefix) -> Result<(), Refusal> {
        let preparing: u64 = state
            .preparing
            .values()
            .map(|&count| u64::from(count))
            .sum();
        if state.unwritable || state.ledger.outstanding + preparing >= self.caps.outstanding {
            return Err(Refusal::BudgetSpent);
        }
        let mine = state.preparing.get(&prefix).copied().unwrap_or(0);
        if mine >= self.caps.preparing_per_prefix {
            return Err(Refusal::PrefixBusy);
        }
        let sent = state
            .ledger
            .networks
            .get(&prefix.to_string())
            .map_or(0, |window| window.count);
        if sent + mine >= self.caps.per_prefix {
            return Err(Refusal::PrefixSpent);
        }
        Ok(())
    }

    fn record(&self, prefix: Prefix) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        self.prune(&mut state);
        state.ledger.outstanding += 1;
        let period = self.period();
        state
            .ledger
            .networks
            .entry(prefix.to_string())
            .or_insert(Window { period, count: 0 })
            .count += 1;
        self.write(&mut state)
    }

    fn period(&self) -> u64 {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        now.as_secs() / self.caps.window.as_secs()
    }

    /// Drops the networks of past periods, from memory and from the ledger file.
    fn prune(&self, state: &mut State) {
        let period = self.period();
        let before = state.ledger.networks.len();
        state
            .ledger
            .networks
            .retain(|_, window| window.period == period);
        if state.ledger.networks.len() < before {
            // A failure is kept in `unwritable`, which stops sponsoring.
            let _ = self.write(state);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> Caps {
        Caps {
            requests_per_minute: NonZeroU32::new(3).unwrap(),
            per_prefix: 2,
            preparing_per_prefix: 2,
            window: Duration::from_secs(3600),
            outstanding: 5,
        }
    }

    fn prefix(ip: &str) -> Prefix {
        Prefix::from(ip.parse::<IpAddr>().unwrap())
    }

    fn sponsor(limits: &Arc<Limits>, ip: &str) {
        Limits::reserve(limits, prefix(ip))
            .unwrap()
            .sponsored()
            .unwrap();
    }

    #[test]
    fn groups_addresses_by_ipv4_slash_24_and_ipv6_slash_64() {
        assert_eq!(prefix("203.0.113.7"), prefix("203.0.113.250"));
        assert_ne!(prefix("203.0.113.7"), prefix("203.0.114.7"));
        assert_eq!(prefix("2001:db8:1:2::1"), prefix("2001:db8:1:2:ffff::9"));
        assert_ne!(prefix("2001:db8:1:2::1"), prefix("2001:db8:1:3::1"));
        assert_eq!(prefix("::ffff:203.0.113.7"), prefix("203.0.113.9"));
        assert_ne!(prefix("203.0.113.7"), prefix("cb00:7100::"));
        assert_eq!(prefix("203.0.113.7").to_string(), "203.0.113.0/24");
        assert_eq!(prefix("2001:db8:1:2::1").to_string(), "2001:db8:1:2::/64");
    }

    #[test]
    fn limits_requests_per_prefix() {
        let limits = Limits::new(caps());
        for _ in 0..3 {
            limits.request(prefix("203.0.113.7")).unwrap();
        }
        assert_eq!(
            limits.request(prefix("203.0.113.8")),
            Err(Refusal::RateLimited)
        );
        limits.request(prefix("198.51.100.1")).unwrap();
    }

    #[test]
    fn caps_sponsorships_per_prefix_and_outstanding() {
        let limits = Arc::new(Limits::new(caps()));
        let home = prefix("203.0.113.7");
        sponsor(&limits, "203.0.113.7");
        sponsor(&limits, "203.0.113.8");
        assert_eq!(limits.may_sponsor(home), Err(Refusal::PrefixSpent));
        assert_eq!(
            Limits::reserve(&limits, home).err(),
            Some(Refusal::PrefixSpent)
        );
        sponsor(&limits, "198.51.100.1");
        sponsor(&limits, "198.51.100.2");
        sponsor(&limits, "192.0.2.1");
        assert_eq!(
            limits.may_sponsor(prefix("192.0.2.200")),
            Err(Refusal::BudgetSpent)
        );
    }

    #[test]
    fn counts_registrations_being_prepared_until_they_are_dropped() {
        let limits = Arc::new(Limits::new(caps()));
        let home = prefix("203.0.113.7");
        let first = Limits::reserve(&limits, home).unwrap();
        let second = Limits::reserve(&limits, home).unwrap();
        assert_eq!(limits.preparing(), 2);
        assert_eq!(limits.may_sponsor(home), Err(Refusal::PrefixBusy));
        drop(first);
        // One sent and one prepared use up the network's two.
        second.sponsored().unwrap();
        let third = Limits::reserve(&limits, home).unwrap();
        assert_eq!(limits.may_sponsor(home), Err(Refusal::PrefixSpent));
        drop(third);
        limits.may_sponsor(home).unwrap();
        assert_eq!(limits.preparing(), 0);

        // Prepared registrations hold the global budget too: 1 sent and 4 prepared of 5.
        let others: Vec<_> = ["198.51.100.1", "198.51.100.1", "192.0.2.1", "192.0.2.1"]
            .into_iter()
            .map(|ip| Limits::reserve(&limits, prefix(ip)).unwrap())
            .collect();
        assert_eq!(
            limits.may_sponsor(prefix("192.88.99.1")),
            Err(Refusal::BudgetSpent)
        );
        drop(others);
        limits.may_sponsor(prefix("192.88.99.1")).unwrap();
    }

    #[test]
    fn concurrent_reservations_never_exceed_the_caps() {
        let limits = Arc::new(Limits::new(Caps {
            per_prefix: 1_000,
            preparing_per_prefix: 1_000,
            ..caps()
        }));
        let granted: Vec<_> = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..64)
                .map(|n| {
                    let limits = &limits;
                    scope.spawn(move || Limits::reserve(limits, prefix(&format!("10.0.{n}.1"))))
                })
                .collect();
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().ok())
                .collect()
        });
        assert_eq!(granted.len(), 5);
    }

    fn ledger_path(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("buckspay-{name}-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn keeps_the_caps_across_a_restart() {
        let path = ledger_path("restart");
        let limits = Arc::new(Limits::open(caps(), &path).unwrap());
        sponsor(&limits, "203.0.113.7");
        sponsor(&limits, "203.0.113.7");
        sponsor(&limits, "2001:db8::1");
        drop(limits);

        let restarted = Limits::open(caps(), &path).unwrap();
        assert_eq!(
            restarted.may_sponsor(prefix("203.0.113.9")),
            Err(Refusal::PrefixSpent)
        );
        // Only network prefixes, the period's number and counts are written.
        let period = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / 3600;
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!(
                r#"{{"outstanding":3,"networks":{{"2001:db8::/64":{{"period":{period},"count":1}},"203.0.113.0/24":{{"period":{period},"count":2}}}}}}"#
            )
        );
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn forgets_a_network_once_its_period_ended() {
        let path = ledger_path("period");
        // Period 1 of the window ended in 1970.
        fs::write(
            &path,
            r#"{"outstanding":2,"networks":{"203.0.113.0/24":{"period":1,"count":2}}}"#,
        )
        .unwrap();
        let limits = Limits::open(caps(), &path).unwrap();
        limits.may_sponsor(prefix("203.0.113.7")).unwrap();
        // Dropped from the file as well.
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"outstanding":2,"networks":{}}"#
        );
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn stops_sponsoring_when_the_ledger_cannot_be_written() {
        let path = std::env::temp_dir()
            .join(format!("buckspay-missing-{}", std::process::id()))
            .join("sponsorships.json");
        let limits = Arc::new(Limits::open(caps(), &path).unwrap());
        let reservation = Limits::reserve(&limits, prefix("203.0.113.7")).unwrap();
        assert!(reservation.sponsored().is_err());
        assert_eq!(
            limits.may_sponsor(prefix("198.51.100.1")),
            Err(Refusal::BudgetSpent)
        );
    }

    #[test]
    fn refuses_a_ledger_it_cannot_read() {
        let path = ledger_path("corrupt");
        fs::write(&path, "{").unwrap();
        assert!(
            Limits::open(caps(), &path)
                .err()
                .unwrap()
                .contains("is not a sponsorship ledger")
        );
        fs::remove_file(&path).unwrap();
    }
}
