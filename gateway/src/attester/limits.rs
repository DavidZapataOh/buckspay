//! What one network and one device key may ask of the attester. Every request counts, answered,
//! refused or failed alike, before anything costs an RPC call; the counters survive a restart, are
//! swept on every request and never hold more than `capacity` entries. Nothing on disk or in memory
//! is an address: networks and keys are kept as a salted hash.
use crate::limits::{Prefix, RequestLimits};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs, io,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const DAY: u32 = 86_400;
/// How often the counters are written to disk, at most.
const PERSIST_EVERY: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub per_minute: NonZeroU32,
    pub per_network_day: u32,
    pub per_key_day: u32,
    pub capacity: usize,
}

impl Settings {
    pub fn pilot() -> Self {
        Self {
            per_minute: NonZeroU32::new(60).unwrap(),
            per_network_day: 2_000,
            per_key_day: 48,
            capacity: 100_000,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Denied;

type Digest16 = [u8; 16];

#[derive(Default, Serialize, Deserialize)]
struct Counts {
    day: u32,
    networks: HashMap<String, u32>,
    keys: HashMap<String, u32>,
}

#[derive(Default)]
struct Daily {
    day: u32,
    next: u64,
    /// Count and insertion order, so the oldest entry goes first when the map is full.
    networks: HashMap<Digest16, (u32, u64)>,
    keys: HashMap<Digest16, (u32, u64)>,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    salt: String,
    #[serde(flatten)]
    counts: Counts,
}

pub struct Limits {
    settings: Settings,
    minute: RequestLimits,
    salt: [u8; 16],
    daily: Mutex<Daily>,
    store: Option<(PathBuf, Mutex<Instant>)>,
}

impl Limits {
    /// Counters kept in memory only.
    pub fn in_memory(settings: Settings) -> Self {
        Self {
            settings,
            minute: RequestLimits::new(settings.per_minute),
            salt: random_salt(),
            daily: Mutex::default(),
            store: None,
        }
    }

    /// Counters kept in `path`, restored if they are of today.
    pub fn open(settings: Settings, path: &Path, now: u32) -> io::Result<Self> {
        let mut limits = Self::in_memory(settings);
        limits.store = Some((path.to_owned(), Mutex::new(Instant::now())));
        if let Ok(text) = fs::read_to_string(path) {
            let corrupt = |what| io::Error::new(io::ErrorKind::InvalidData, what);
            let stored: Stored =
                serde_json::from_str(&text).map_err(|_| corrupt("counters are corrupt"))?;
            limits.salt = hex::decode(&stored.salt)
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| corrupt("salt is corrupt"))?;
            if stored.counts.day == now / DAY {
                *limits.daily.get_mut().unwrap() = Daily::from_counts(stored.counts);
            }
        }
        limits.persist()?;
        Ok(limits)
    }

    fn digest(&self, tag: u8, bytes: &[u8]) -> Digest16 {
        let hash = Sha256::new()
            .chain_update(self.salt)
            .chain_update([tag])
            .chain_update(bytes)
            .finalize();
        hash[..16].try_into().unwrap()
    }

    /// Counts a request from `prefix`, before its body is read.
    pub fn admit_network(&self, prefix: Prefix, now: u32) -> Result<(), Denied> {
        let minute = self.minute.check(prefix).map_err(|_| Denied);
        let octets = match prefix {
            Prefix::V4(octets) => octets.to_vec(),
            Prefix::V6(octets) => octets.to_vec(),
        };
        let key = self.digest(0, &octets);
        let mut daily = self.daily.lock().unwrap();
        daily.sweep(now / DAY);
        let count = daily.bump(true, key, self.settings.capacity);
        drop(daily);
        self.persist_if_due();
        minute?;
        if count > self.settings.per_network_day {
            return Err(Denied);
        }
        Ok(())
    }

    /// Counts the locks a request names, once it parsed and before anything is read from chain.
    pub fn admit_keys(&self, keys: &[[u8; 33]], now: u32) -> Result<(), Denied> {
        let mut daily = self.daily.lock().unwrap();
        daily.sweep(now / DAY);
        let mut over = false;
        for key in keys {
            let count = daily.bump(false, self.digest(1, key), self.settings.capacity);
            over |= count > self.settings.per_key_day;
        }
        drop(daily);
        self.persist_if_due();
        if over { Err(Denied) } else { Ok(()) }
    }

    /// Entries held right now: networks and keys.
    pub fn held(&self) -> (usize, usize) {
        let daily = self.daily.lock().unwrap();
        (daily.networks.len(), daily.keys.len())
    }

    fn persist_if_due(&self) {
        if let Some((_, last)) = &self.store {
            let mut last = last.lock().unwrap();
            if last.elapsed() >= PERSIST_EVERY {
                *last = Instant::now();
                drop(last);
                // A failed write loses at most the counts of a few seconds.
                let _ = self.persist();
            }
        }
    }

    /// Writes the counters atomically: a temporary file in the same directory, then a rename.
    pub fn persist(&self) -> io::Result<()> {
        let Some((path, _)) = &self.store else {
            return Ok(());
        };
        let stored = Stored {
            salt: hex::encode(self.salt),
            counts: self.daily.lock().unwrap().counts(),
        };
        let directory = path.parent().unwrap_or(Path::new("."));
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer(&mut file, &stored)?;
        file.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
}

impl Daily {
    fn from_counts(counts: Counts) -> Self {
        let load = |map: HashMap<String, u32>| {
            map.into_iter()
                .enumerate()
                .filter_map(|(i, (key, count))| {
                    let bytes: Digest16 = hex::decode(key).ok()?.try_into().ok()?;
                    Some((bytes, (count, i as u64)))
                })
                .collect::<HashMap<_, _>>()
        };
        let networks = load(counts.networks);
        let keys = load(counts.keys);
        Self {
            day: counts.day,
            next: (networks.len() + keys.len()) as u64,
            networks,
            keys,
        }
    }

    fn counts(&self) -> Counts {
        let dump = |map: &HashMap<Digest16, (u32, u64)>| {
            map.iter()
                .map(|(key, (count, _))| (hex::encode(key), *count))
                .collect()
        };
        Counts {
            day: self.day,
            networks: dump(&self.networks),
            keys: dump(&self.keys),
        }
    }

    /// Forgets yesterday: the counters are per UTC day.
    fn sweep(&mut self, day: u32) {
        if self.day != day {
            *self = Self {
                day,
                ..Self::default()
            };
        }
    }

    /// Adds one to the entry of `key`, evicting the oldest entry when the map is full, and returns
    /// its count.
    fn bump(&mut self, network: bool, key: Digest16, capacity: usize) -> u32 {
        self.next += 1;
        let order = self.next;
        let map = if network {
            &mut self.networks
        } else {
            &mut self.keys
        };
        if !map.contains_key(&key)
            && map.len() >= capacity
            && let Some(oldest) = map.iter().min_by_key(|(_, (_, o))| *o).map(|(k, _)| *k)
        {
            map.remove(&oldest);
        }
        let entry = map.entry(key).or_insert((0, order));
        entry.0 = entry.0.saturating_add(1);
        entry.0
    }
}

fn random_salt() -> [u8; 16] {
    use solana_signer::Signer;
    solana_keypair::Keypair::new().pubkey().to_bytes()[..16]
        .try_into()
        .unwrap()
}
