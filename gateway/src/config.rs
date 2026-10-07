use crate::{
    fees::APP_MAX_PRIORITY_FEE,
    hpke::HpkeKeys,
    sponsor::{Caps, Escalation, FeeMode, Step},
};
use buckspay_protocol::{
    cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH},
    profile::{PRODUCTION_DEVNET_PROGRAM_ID, SHORT_PROGRAM_ID},
};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use std::{
    env, fs,
    net::SocketAddr,
    num::NonZeroU32,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    str::FromStr,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cluster {
    Devnet,
    /// A local validator running the devnet build of the program, as the app's localnet builds.
    Localnet,
}

impl Cluster {
    /// `BUCKSPAY_CLUSTER`. Mainnet is refused: its gateway runs on a dedicated host that no other
    /// account can administer, never on a host shared with development (`SHARED_HOST`, the
    /// default), where every account with root-equivalent groups can read the keys.
    pub fn parse(value: Option<&str>, shared_host: bool) -> Result<Self, String> {
        match value {
            Some("devnet") => Ok(Self::Devnet),
            Some("localnet") => Ok(Self::Localnet),
            Some("mainnet") if shared_host => {
                Err("a mainnet gateway never runs on a shared host (SHARED_HOST)".into())
            }
            Some("mainnet") => Err("this build sponsors on devnet only".into()),
            _ => Err("BUCKSPAY_CLUSTER must be devnet or localnet".into()),
        }
    }

    /// The genesis hash device bindings sign for: the cluster the program is built for.
    pub fn binding_genesis_hash(self) -> [u8; 32] {
        DEVNET_GENESIS_HASH
    }

    /// Refuses an RPC that serves another cluster: devnet must be devnet, and a local validator
    /// is neither devnet nor mainnet.
    pub fn check_rpc_genesis_hash(self, genesis: [u8; 32]) -> Result<(), String> {
        let served = match self {
            Cluster::Devnet => genesis == DEVNET_GENESIS_HASH,
            Cluster::Localnet => genesis != DEVNET_GENESIS_HASH && genesis != MAINNET_GENESIS_HASH,
        };
        if !served {
            return Err(format!("RPC_URL serves another cluster than {self:?}"));
        }
        Ok(())
    }
}

/// Which build of the program the gateway sponsors: the one real users' locks live in, or the
/// short-windows build with its own program id, for checks that cannot wait for days.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Profile {
    Production,
    Short,
}

impl Profile {
    /// `BUCKSPAY_PROFILE`. The short profile exists on devnet only, which is the only cluster a
    /// gateway of this build runs on (`Cluster::parse` refuses mainnet).
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("production") => Ok(Self::Production),
            Some("short") => Ok(Self::Short),
            Some(_) => Err("BUCKSPAY_PROFILE must be production or short".into()),
        }
    }

    /// The program id of this profile. `configured` is `PROGRAM_ID` if set, which must be it.
    pub fn program_id(self, configured: Option<&str>) -> Result<Pubkey, String> {
        let own = match self {
            Self::Production => PRODUCTION_DEVNET_PROGRAM_ID,
            Self::Short => SHORT_PROGRAM_ID,
        };
        match configured {
            Some(id) if id != own => Err(format!(
                "PROGRAM_ID is not the program id of the {self:?} profile"
            )),
            _ => Ok(Pubkey::from_str(own).expect("the profile's program id is an address")),
        }
    }
}

/// Where the gateway listens.
#[derive(Debug, PartialEq)]
pub enum Listen {
    /// A TCP address, for development: the client's address is the connection's.
    Tcp(SocketAddr),
    /// A Unix socket behind the reverse proxy (`unix:/path`): only the proxy can connect, and the
    /// client's address is the one it puts in `X-Real-IP`.
    Unix(PathBuf),
}

impl std::str::FromStr for Listen {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, String> {
        match value.strip_prefix("unix:") {
            Some(path) if path.starts_with('/') => Ok(Self::Unix(path.into())),
            Some(_) => Err("BIND unix: needs an absolute path".into()),
            None => value
                .parse()
                .map(Self::Tcp)
                .map_err(|_| "BIND is neither an address nor unix:/path".into()),
        }
    }
}

pub struct Config {
    pub cluster: Cluster,
    pub rpc_url: String,
    pub listen: Listen,
    pub fee_payer: Keypair,
    pub hpke: HpkeKeys,
    /// Where the sponsorship ledger is kept (systemd's `StateDirectory`).
    pub state_directory: PathBuf,
    pub max_priority_fee: u64,
    pub requests_per_minute: NonZeroU32,
    /// Native verifications of private settlements one network may ask for in a minute.
    pub zk_verifications_per_minute: NonZeroU32,
    /// Where the key files of private settlement are published, under `/zk/<vkSha256>/`.
    pub zk_keys_url: Option<String>,
    /// The longest random wait, in seconds, before a relayed settlement is sent.
    pub relay_delay_max_secs: u32,
    /// Relayed settlements sponsored in one day, all relayers together.
    pub relay_daily_cap: u32,
    /// Open `Channel` accounts the gateway may pay rent for at once.
    pub max_open_channels: usize,
    /// Channels one network may have the gateway open in a day.
    pub new_channels_per_network_day: u32,
    pub caps: Caps,
    /// Lamports of rent the gateway may have out in settlement records.
    pub settlement_float_cap: u64,
    /// Lamports of rent the gateway may have out in claim accounts at once.
    pub claim_float_cap: u64,
    /// Base units of bond a lock needs for each open sponsored settlement record.
    pub settlement_bond_per_record: u64,
    /// The bond a lock needs before it may hold any sponsored record, in base units of the mint.
    pub settlement_min_bond: u64,
    pub program_id: Pubkey,
    /// The one mint the gateway sponsors locks of.
    pub mint: Pubkey,
    /// Sponsored locks are at most this many days long.
    pub max_lock_days: u32,
    pub fee_mode: FeeMode,
    /// A token account of the mint owned by the fee payer, which receives the `cost_plus` fee.
    pub fee_token: Option<Pubkey>,
    /// Micro-units of the mint per SOL: the operator's price for the `cost_plus` fee, no oracle.
    pub sol_price_micro_usdc: Option<u64>,
    /// Other addresses the gateway signs for, besides the fee payer: no endpoint accepts them as a
    /// wallet.
    pub held_keys: Vec<Pubkey>,
}

/// The slots of the HPKE keys from a JSON file `[{ "path", "notBefore", "notAfter" }]`, current
/// first. Only the keys whose slot has begun are read: the files of later slots stay off the
/// gateway until an hour before their time.
fn read_schedule(file: &Path) -> Result<HpkeKeys, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Slot {
        path: PathBuf,
        not_before: u64,
        not_after: u64,
    }
    let slots: Vec<Slot> = serde_json::from_slice(
        &std::fs::read(file).map_err(|error| format!("{}: {error}", file.display()))?,
    )
    .map_err(|error| format!("{}: {error}", file.display()))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let slots: Vec<_> = slots
        .iter()
        .map(|slot| (slot.path.as_path(), slot.not_before, slot.not_after))
        .collect();
    HpkeKeys::read_schedule(&slots, now)
}

fn var<T: std::str::FromStr>(name: &str, default: &str) -> Result<T, String> {
    env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .parse()
        .map_err(|_| format!("{name} is not valid"))
}

fn min_bond(value: Option<&str>) -> Result<u64, String> {
    match value.unwrap_or("10000000").parse::<u64>() {
        Ok(bond) if bond > 0 => Ok(bond),
        _ => Err("SETTLEMENT_MIN_BOND is not valid".to_owned()),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let cluster = Cluster::parse(
            env::var("BUCKSPAY_CLUSTER").ok().as_deref(),
            var("SHARED_HOST", "true")?,
        )?;
        let rpc_url = env::var("RPC_URL").map_err(|_| "RPC_URL is not set")?;
        let fee_payer =
            env::var("FEE_PAYER_KEYPAIR").map_err(|_| "FEE_PAYER_KEYPAIR is not set")?;
        let hpke = match env::var("HPKE_SCHEDULE") {
            Ok(schedule) => read_schedule(Path::new(&schedule))?,
            Err(_) => {
                let hpke_key = env::var("HPKE_KEY").map_err(|_| "HPKE_KEY is not set")?;
                // During a rotation, the key it replaces, until no app pins it alone.
                let hpke_previous_key = env::var("HPKE_PREVIOUS_KEY").ok();
                let mut hpke_keys = vec![Path::new(&hpke_key)];
                hpke_keys.extend(hpke_previous_key.as_deref().map(Path::new));
                HpkeKeys::read(&hpke_keys)?
            }
        };
        let max_priority_fee = var("MAX_PRIORITY_FEE", "100000")?;
        if max_priority_fee > APP_MAX_PRIORITY_FEE {
            return Err(format!(
                "MAX_PRIORITY_FEE is above {APP_MAX_PRIORITY_FEE}, the most the app accepts"
            ));
        }
        let profile = Profile::parse(env::var("BUCKSPAY_PROFILE").ok().as_deref())?;
        let program_id = profile.program_id(env::var("PROGRAM_ID").ok().as_deref())?;
        let defaults = Escalation::default();
        let escalation = Escalation {
            base_min_funding: var(
                "MIN_SPONSORED_FUNDING",
                &defaults.base_min_funding.to_string(),
            )?,
            steps: match env::var("ESCALATION_STEPS") {
                Ok(steps) => parse_steps(&steps)?,
                Err(_) => defaults.steps,
            },
            fee_on_percent: var("ESCALATION_FEE_ON_PERCENT", "50")?,
            fee_off_percent: var("ESCALATION_FEE_OFF_PERCENT", "40")?,
        };
        let fee_mode = match env::var("ONBOARDING_FEE_MODE").as_deref() {
            Err(_) | Ok("off") => FeeMode::Off,
            Ok("cost_plus") => FeeMode::CostPlus,
            Ok(_) => return Err("ONBOARDING_FEE_MODE must be off or cost_plus".into()),
        };
        Ok(Self {
            cluster,
            rpc_url,
            listen: var("BIND", "127.0.0.1:8080")?,
            fee_payer: read_keypair(Path::new(&fee_payer))?,
            hpke,
            state_directory: env::var("STATE_DIRECTORY")
                .map_err(|_| "STATE_DIRECTORY is not set")?
                .into(),
            max_priority_fee,
            requests_per_minute: var("REQUESTS_PER_MINUTE", "30")?,
            zk_verifications_per_minute: var("ZK_VERIFICATIONS_PER_MINUTE", "6")?,
            zk_keys_url: env::var("ZK_KEYS_URL").ok().filter(|url| !url.is_empty()),
            relay_delay_max_secs: var("RELAY_DELAY_MAX_SECS", "30")?,
            relay_daily_cap: var("RELAY_DAILY_CAP", "1000")?,
            max_open_channels: var("MAX_OPEN_CHANNELS", "1000")?,
            new_channels_per_network_day: var("NEW_CHANNELS_PER_IP_DAY", "10")?,
            caps: Caps {
                cac_budget: var("CAC_BUDGET_LAMPORTS", "500000000")?,
                open_rent_cap: var("OPEN_RENT_CAP_LAMPORTS", "600000000")?,
                daily_onboardings: var("SPONSORED_DAILY_ONBOARDINGS", "200")?,
                per_prefix_per_day: var("SPONSORED_PER_PREFIX_PER_DAY", "5")?,
                per_prefix_per_30_days: var("SPONSORED_PER_PREFIX_PER_30_DAYS", "10")?,
                preparing_per_prefix: var("PREPARING_PER_PREFIX", "3")?,
                escalation,
            },
            settlement_float_cap: var("SETTLEMENT_FLOAT_CAP_LAMPORTS", "1000000000")?,
            claim_float_cap: var("CLAIM_FLOAT_CAP_LAMPORTS", "500000000")?,
            settlement_bond_per_record: var("SETTLEMENT_BOND_PER_RECORD", "1000000")?,
            settlement_min_bond: min_bond(env::var("SETTLEMENT_MIN_BOND").ok().as_deref())?,
            program_id,
            mint: Pubkey::from_str(&env::var("MINT").map_err(|_| "MINT is not set")?)
                .map_err(|_| "MINT is not an address")?,
            max_lock_days: var("SPONSORED_MAX_LOCK_DAYS", "45")?,
            fee_mode,
            fee_token: optional_address("FEE_TOKEN_ACCOUNT")?,
            sol_price_micro_usdc: env::var("SOL_PRICE_MICRO_USDC")
                .ok()
                .map(|price| {
                    price
                        .parse()
                        .map_err(|_| "SOL_PRICE_MICRO_USDC is not valid")
                })
                .transpose()?,
            held_keys: match env::var("GATEWAY_KEYS") {
                Ok(keys) => keys
                    .split(',')
                    .map(|key| {
                        Pubkey::from_str(key.trim())
                            .map_err(|_| "GATEWAY_KEYS holds an invalid address".to_owned())
                    })
                    .collect::<Result<_, _>>()?,
                Err(_) => Vec::new(),
            },
        })
    }
}

fn optional_address(name: &str) -> Result<Option<Pubkey>, String> {
    env::var(name)
        .ok()
        .map(|value| Pubkey::from_str(&value).map_err(|_| format!("{name} is not an address")))
        .transpose()
}

/// `ESCALATION_STEPS`: `percent:funding` pairs, ascending in percent, separated by commas.
fn parse_steps(value: &str) -> Result<Vec<Step>, String> {
    let invalid = || "ESCALATION_STEPS is not valid".to_owned();
    let steps: Vec<Step> = value
        .split(',')
        .map(|pair| {
            let (percent, funding) = pair.split_once(':').ok_or_else(invalid)?;
            Ok(Step {
                at_percent: percent.trim().parse().map_err(|_| invalid())?,
                min_funding: funding.trim().parse().map_err(|_| invalid())?,
            })
        })
        .collect::<Result<_, String>>()?;
    if steps
        .windows(2)
        .any(|pair| pair[0].at_percent >= pair[1].at_percent)
    {
        return Err("ESCALATION_STEPS must ascend in percent".into());
    }
    Ok(steps)
}

/// Refuses a key file that users other than its owner can read.
///
/// systemd copies `LoadCredential=` files into `$CREDENTIALS_DIRECTORY` as `0440` files owned by
/// root that "only the UID associated with the unit via `User=` (and the superuser)" can read,
/// through an ACL (systemd.exec(5), "Credentials"). Their group bits only mirror that ACL, so
/// inside that directory a key file is refused for its world bits alone.
pub fn check_key_file(path: &Path) -> Result<(), String> {
    let credentials = env::var_os("CREDENTIALS_DIRECTORY").map(PathBuf::from);
    check_key_file_in(path, credentials.as_deref())
}

fn check_key_file_in(path: &Path, credentials: Option<&Path>) -> Result<(), String> {
    let name = path.display();
    let mode = fs::metadata(path)
        .map_err(|error| format!("{name}: {error}"))?
        .permissions()
        .mode();
    let is_credential = credentials.is_some_and(|directory| {
        match (fs::canonicalize(path), fs::canonicalize(directory)) {
            (Ok(file), Ok(directory)) => file.starts_with(directory),
            _ => false,
        }
    });
    let others = if is_credential { 0o007 } else { 0o077 };
    if mode & others != 0 {
        return Err(format!(
            "{name} must not be readable by other users (chmod 600)"
        ));
    }
    Ok(())
}

/// Reads a `solana-keygen` keypair file, refusing one that other users can read.
pub fn read_keypair(path: &Path) -> Result<Keypair, String> {
    let name = path.display();
    check_key_file(path)?;
    let bytes: Vec<u8> = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("{name}: {error}"))?,
    )
    .map_err(|_| format!("{name} is not a keypair file"))?;
    Keypair::try_from(bytes.as_slice()).map_err(|_| format!("{name} is not a keypair file"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_signer::Signer;

    #[test]
    fn refuses_mainnet_and_an_rpc_of_another_cluster() {
        assert_eq!(Cluster::parse(Some("devnet"), true), Ok(Cluster::Devnet));
        assert_eq!(
            Cluster::parse(Some("localnet"), true),
            Ok(Cluster::Localnet)
        );
        assert!(
            Cluster::parse(Some("mainnet"), true)
                .unwrap_err()
                .contains("shared host")
        );
        assert!(Cluster::parse(Some("mainnet"), false).is_err());
        assert!(Cluster::parse(None, false).is_err());

        let local = [7; 32];
        Cluster::Devnet
            .check_rpc_genesis_hash(DEVNET_GENESIS_HASH)
            .unwrap();
        Cluster::Localnet.check_rpc_genesis_hash(local).unwrap();
        for (cluster, genesis) in [
            (Cluster::Devnet, local),
            (Cluster::Devnet, MAINNET_GENESIS_HASH),
            (Cluster::Localnet, DEVNET_GENESIS_HASH),
            (Cluster::Localnet, MAINNET_GENESIS_HASH),
        ] {
            assert!(
                cluster.check_rpc_genesis_hash(genesis).is_err(),
                "{cluster:?}"
            );
        }
    }

    #[test]
    fn listens_on_tcp_or_a_unix_socket() {
        assert_eq!(
            "127.0.0.1:8080".parse(),
            Ok(Listen::Tcp("127.0.0.1:8080".parse().unwrap()))
        );
        assert_eq!(
            "unix:/run/buckspay-gateway/gateway.sock".parse(),
            Ok(Listen::Unix("/run/buckspay-gateway/gateway.sock".into()))
        );
        assert!("unix:gateway.sock".parse::<Listen>().is_err());
        assert!("localhost".parse::<Listen>().is_err());
    }

    #[test]
    fn reads_a_keypair_file_only_its_owner_can_read() {
        let keypair = Keypair::new();
        let path = env::temp_dir().join(format!("buckspay-gateway-{}.json", std::process::id()));
        fs::write(
            &path,
            serde_json::to_string(&keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_keypair(&path).unwrap_err().contains("chmod 600"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_keypair(&path).unwrap().pubkey(), keypair.pubkey());
        fs::write(&path, "[1, 2, 3]").unwrap();
        assert!(
            read_keypair(&path)
                .unwrap_err()
                .contains("is not a keypair file")
        );
        fs::remove_file(&path).unwrap();
        assert!(read_keypair(&path).is_err());
    }

    #[test]
    fn accepts_systemd_credentials_without_world_bits() {
        let credentials =
            env::temp_dir().join(format!("buckspay-credentials-{}", std::process::id()));
        fs::create_dir_all(&credentials).unwrap();
        let credential = credentials.join("fee-payer");
        fs::write(&credential, "[]").unwrap();
        fs::set_permissions(&credential, fs::Permissions::from_mode(0o440)).unwrap();
        assert_eq!(check_key_file_in(&credential, Some(&credentials)), Ok(()));
        assert!(check_key_file_in(&credential, None).is_err());
        fs::set_permissions(&credential, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(
            check_key_file_in(&credential, Some(&credentials))
                .unwrap_err()
                .contains("chmod 600")
        );

        let elsewhere = env::temp_dir().join(format!("buckspay-key-{}.json", std::process::id()));
        fs::write(&elsewhere, "[]").unwrap();
        fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(
            check_key_file_in(&elsewhere, Some(&credentials))
                .unwrap_err()
                .contains("chmod 600")
        );
        fs::remove_file(&elsewhere).unwrap();
        fs::remove_dir_all(&credentials).unwrap();
    }

    #[test]
    fn a_profile_has_one_program_id() {
        assert_eq!(Profile::parse(None), Ok(Profile::Production));
        assert_eq!(Profile::parse(Some("short")), Ok(Profile::Short));
        assert!(Profile::parse(Some("staging")).is_err());
        let production = Profile::Production.program_id(None).unwrap();
        let short = Profile::Short.program_id(None).unwrap();
        assert_ne!(production, short);
        assert_eq!(Profile::Short.program_id(Some(SHORT_PROGRAM_ID)), Ok(short));
        assert!(
            Profile::Short
                .program_id(Some(PRODUCTION_DEVNET_PROGRAM_ID))
                .is_err()
        );
        assert!(
            Profile::Production
                .program_id(Some(SHORT_PROGRAM_ID))
                .is_err()
        );
    }

    #[test]
    fn escalation_steps_must_ascend() {
        let steps = parse_steps("50:5000000, 65:10000000").unwrap();
        assert_eq!(
            steps,
            [
                Step {
                    at_percent: 50,
                    min_funding: 5_000_000
                },
                Step {
                    at_percent: 65,
                    min_funding: 10_000_000
                }
            ]
        );
        assert!(parse_steps("65:1,50:2").is_err());
        assert!(parse_steps("50").is_err());
    }

    #[test]
    fn the_minimum_bond_defaults_to_ten_tokens_and_is_never_zero() {
        assert_eq!(min_bond(None), Ok(10_000_000));
        assert_eq!(min_bond(Some("500000")), Ok(500_000));
        assert!(min_bond(Some("0")).is_err());
        assert!(min_bond(Some("18446744073709551616")).is_err());
        assert!(min_bond(Some("ten")).is_err());
    }
}
