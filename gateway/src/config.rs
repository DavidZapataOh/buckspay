use crate::{fees::APP_MAX_PRIORITY_FEE, hpke::HpkeKeys, limits::Caps};
use buckspay_protocol::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};
use solana_keypair::Keypair;
use std::{
    env, fs,
    net::SocketAddr,
    num::NonZeroU32,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
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
    pub caps: Caps,
}

fn var<T: std::str::FromStr>(name: &str, default: &str) -> Result<T, String> {
    env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .parse()
        .map_err(|_| format!("{name} is not valid"))
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
        let hpke_key = env::var("HPKE_KEY").map_err(|_| "HPKE_KEY is not set")?;
        // During a rotation, the key it replaces, until no app pins it alone.
        let hpke_previous_key = env::var("HPKE_PREVIOUS_KEY").ok();
        let mut hpke_keys = vec![Path::new(&hpke_key)];
        hpke_keys.extend(hpke_previous_key.as_deref().map(Path::new));
        let max_priority_fee = var("MAX_PRIORITY_FEE", "100000")?;
        if max_priority_fee > APP_MAX_PRIORITY_FEE {
            return Err(format!(
                "MAX_PRIORITY_FEE is above {APP_MAX_PRIORITY_FEE}, the most the app accepts"
            ));
        }
        Ok(Self {
            cluster,
            rpc_url,
            listen: var("BIND", "127.0.0.1:8080")?,
            fee_payer: read_keypair(Path::new(&fee_payer))?,
            hpke: HpkeKeys::read(&hpke_keys)?,
            state_directory: env::var("STATE_DIRECTORY")
                .map_err(|_| "STATE_DIRECTORY is not set")?
                .into(),
            max_priority_fee,
            caps: Caps {
                requests_per_minute: var::<NonZeroU32>("REQUESTS_PER_MINUTE", "30")?,
                per_prefix: var("SPONSORED_PER_PREFIX_PER_DAY", "20")?,
                preparing_per_prefix: var("PREPARING_PER_PREFIX", "3")?,
                window: Duration::from_secs(24 * 60 * 60),
                outstanding: var("SPONSORED_OUTSTANDING", "1000")?,
            },
        })
    }
}

/// Reads a `solana-keygen` keypair file, refusing one that other users can read.
pub fn read_keypair(path: &Path) -> Result<Keypair, String> {
    let name = path.display();
    let metadata = fs::metadata(path).map_err(|error| format!("{name}: {error}"))?;
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "{name} must not be readable by other users (chmod 600)"
        ));
    }
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
}
