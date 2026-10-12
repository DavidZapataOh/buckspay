//! A faucet of the test mint, for builds that run on a test network: a wallet asks for some of it
//! and the gateway creates its token account and mints it, paying the network cost. The mint is the
//! devnet test token, which is worth nothing, so the limits are about the sponsor's SOL, not about
//! value: one claim per wallet a day, and a cap per network and per day.
use crate::{
    chain::ASSOCIATED_TOKEN_PROGRAM,
    limits::Prefix,
    server::{Client, Error, Gateway},
    sponsored::{Outcome, confirm},
    transactions,
};
use axum::{Extension, Json, extract::State};
use serde::{Deserialize, Serialize};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// How long a wallet waits between two claims, in seconds.
pub const WALLET_INTERVAL: u64 = 86_400;
/// The compute units of creating a token account and minting into it, with room.
const COMPUTE_UNITS: u32 = 60_000;
/// What the fee payer must keep, in lamports, for a claim to go ahead: the rent of a token account
/// and the fees, with room.
const MIN_FEE_PAYER_BALANCE: u64 = 10_000_000;

/// Why a claim was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// This wallet claimed lately: the seconds until it may claim again.
    Wait(u64),
    /// The claims of this network are used up for today.
    NetworkSpentToday,
    /// The claims of every network are used up for today.
    SpentToday,
    /// The record of claims could not be written: nothing is minted that is not on record.
    Unwritable,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    /// The wallets that claimed, by base58, and when.
    claims: HashMap<String, u64>,
}

#[derive(Default)]
struct Today {
    day: u64,
    total: u32,
    networks: HashMap<Prefix, u32>,
}

pub struct Faucet {
    authority: Keypair,
    token_program: Pubkey,
    /// Base units of the mint each claim receives.
    pub amount: u64,
    daily_cap: u32,
    per_network_daily: u32,
    record: Mutex<(Claims, Today)>,
    path: Option<PathBuf>,
}

impl Faucet {
    /// A faucet of the mint `authority` controls, keeping its record of claims in `path` when given.
    pub fn open(
        authority: Keypair,
        token_program: Pubkey,
        amount: u64,
        daily_cap: u32,
        per_network_daily: u32,
        path: Option<&Path>,
    ) -> Result<Self, String> {
        let state = match path {
            Some(path) => match fs::read(path) {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|error| format!("{}: {error}", path.display()))?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => Claims::default(),
                Err(error) => return Err(format!("{}: {error}", path.display())),
            },
            None => Claims::default(),
        };
        Ok(Self {
            authority,
            token_program,
            amount,
            daily_cap,
            per_network_daily,
            record: Mutex::new((state, Today::default())),
            path: path.map(Path::to_path_buf),
        })
    }

    /// Takes a claim of `wallet` from `network` at `now`, or says why not. The claim stays on record
    /// until `release` takes it back, so two requests at once cannot both be served.
    pub fn admit(&self, wallet: &Pubkey, network: Prefix, now: u64) -> Result<(), Refusal> {
        let mut record = self.record.lock().unwrap();
        let (state, today) = &mut *record;
        if today.day != now / 86_400 {
            *today = Today {
                day: now / 86_400,
                ..Today::default()
            };
        }
        state
            .claims
            .retain(|_, claimed| now < claimed.saturating_add(WALLET_INTERVAL));
        let key = wallet.to_string();
        if let Some(claimed) = state.claims.get(&key) {
            return Err(Refusal::Wait(claimed + WALLET_INTERVAL - now));
        }
        if today.total >= self.daily_cap {
            return Err(Refusal::SpentToday);
        }
        if today.networks.get(&network).copied().unwrap_or(0) >= self.per_network_daily {
            return Err(Refusal::NetworkSpentToday);
        }
        state.claims.insert(key.clone(), now);
        if self.write(state).is_err() {
            state.claims.remove(&key);
            return Err(Refusal::Unwritable);
        }
        today.total += 1;
        *today.networks.entry(network).or_default() += 1;
        Ok(())
    }

    /// Takes back a claim whose mint never happened.
    pub fn release(&self, wallet: &Pubkey, network: Prefix) {
        let mut record = self.record.lock().unwrap();
        let (state, today) = &mut *record;
        if state.claims.remove(&wallet.to_string()).is_some() {
            today.total = today.total.saturating_sub(1);
            if let Some(count) = today.networks.get_mut(&network) {
                *count = count.saturating_sub(1);
            }
            let _ = self.write(state);
        }
    }

    fn write(&self, state: &Claims) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec(state)?)?;
        fs::rename(temporary, path)
    }

    /// Creates the wallet's token account if it has none, then mints the amount into it.
    pub fn instructions(&self, payer: &Pubkey, wallet: &Pubkey, mint: &Pubkey) -> [Instruction; 2] {
        let account = crate::chain::associated_token_address(wallet, mint, &self.token_program);
        let create = Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new(account, false),
                AccountMeta::new_readonly(*wallet, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(Pubkey::default(), false),
                AccountMeta::new_readonly(self.token_program, false),
            ],
            // `CreateIdempotent`.
            data: vec![1],
        };
        let mut data = vec![7];
        data.extend_from_slice(&self.amount.to_le_bytes());
        let mint_to = Instruction {
            program_id: self.token_program,
            accounts: vec![
                AccountMeta::new(*mint, false),
                AccountMeta::new(account, false),
                AccountMeta::new_readonly(self.authority.pubkey(), true),
            ],
            data,
        };
        [create, mint_to]
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    /// Base units each claim receives, as a decimal string.
    amount: String,
}

/// What a claim receives, or `404` on a gateway without a faucet.
pub async fn offer(State(state): State<Arc<Gateway>>) -> Result<Json<Offer>, Error> {
    let faucet = state.faucet.as_ref().ok_or(Error::NotFound("faucet"))?;
    Ok(Json(Offer {
        amount: faucet.amount.to_string(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimRequest {
    /// The wallet's address, base58.
    wallet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claimed {
    signature: String,
    amount: String,
}

/// Mints the amount into the wallet's token account, which it creates first when it has none.
pub async fn claim(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<ClaimRequest>,
) -> Result<Json<Claimed>, Error> {
    let faucet = state.faucet.as_ref().ok_or(Error::NotFound("faucet"))?;
    let wallet: Pubkey = request
        .wallet
        .parse()
        .map_err(|_| Error::BadRequest("the wallet is not an address"))?;
    if state.is_ours(&wallet) || wallet == faucet.authority.pubkey() {
        return Err(Error::BadRequest("the wallet is not an address"));
    }
    let balance = state
        .rpc
        .get_balance(&state.fee_payer.pubkey())
        .await
        .map_err(|_| Error::Upstream)?;
    if balance < MIN_FEE_PAYER_BALANCE {
        return Err(Error::Unfunded);
    }
    let network = Prefix::from(ip);
    faucet
        .admit(&wallet, network, now())
        .map_err(Error::Faucet)?;
    match send(&state, faucet, &wallet).await {
        Ok(signature) => Ok(Json(Claimed {
            signature,
            amount: faucet.amount.to_string(),
        })),
        Err((error, minted)) => {
            if !minted {
                faucet.release(&wallet, network);
            }
            Err(error)
        }
    }
}

/// Sends the claim and waits for it; the flag says the mint may have landed.
async fn send(state: &Gateway, faucet: &Faucet, wallet: &Pubkey) -> Result<String, (Error, bool)> {
    let fee_payer = state.fee_payer.pubkey();
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(|_| (Error::Upstream, false))?;
    let instructions = faucet.instructions(&fee_payer, wallet, &state.settings.mint);
    let message = transactions::compose(&fee_payer, COMPUTE_UNITS, 0, &instructions, blockhash);
    let bytes = message.serialize();
    let required = usize::from(message.header().num_required_signatures);
    let signatures = message.static_account_keys()[..required]
        .iter()
        .map(|key| {
            if *key == fee_payer {
                state.fee_payer.sign_message(&bytes)
            } else {
                faucet.authority.sign_message(&bytes)
            }
        })
        .collect();
    let transaction = VersionedTransaction {
        signatures,
        message,
    };
    let signature = state
        .rpc
        .send_transaction(&transaction)
        .await
        .map_err(|_| (Error::Rejected, false))?;
    match confirm(state, &signature).await {
        Outcome::Landed => Ok(signature.to_string()),
        Outcome::FailedOnChain => Err((Error::Failed, false)),
        _ => Err((Error::Upstream, true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    const NOW: u64 = 1_800_000_000;

    fn network(last: u8) -> Prefix {
        Prefix::from(IpAddr::V4(Ipv4Addr::new(10, 0, last, 7)))
    }

    fn faucet(daily: u32, per_network: u32, path: Option<&Path>) -> Faucet {
        Faucet::open(
            Keypair::new(),
            crate::chain::TOKEN_PROGRAM,
            20_000_000,
            daily,
            per_network,
            path,
        )
        .unwrap()
    }

    #[test]
    fn a_wallet_claims_once_and_is_told_when_it_may_claim_again() {
        let faucet = faucet(10, 10, None);
        let wallet = Pubkey::new_unique();
        assert_eq!(faucet.admit(&wallet, network(1), NOW), Ok(()));
        assert_eq!(
            faucet.admit(&wallet, network(1), NOW + 3_600),
            Err(Refusal::Wait(WALLET_INTERVAL - 3_600))
        );
        assert_eq!(
            faucet.admit(&wallet, network(1), NOW + WALLET_INTERVAL),
            Ok(())
        );
    }

    #[test]
    fn the_same_wallet_cannot_get_around_the_wait_from_another_network() {
        let faucet = faucet(10, 10, None);
        let wallet = Pubkey::new_unique();
        faucet.admit(&wallet, network(1), NOW).unwrap();
        assert!(matches!(
            faucet.admit(&wallet, network(2), NOW + 10),
            Err(Refusal::Wait(_))
        ));
    }

    #[test]
    fn a_network_and_the_whole_faucet_have_a_daily_cap_that_a_new_day_clears() {
        let faucet = faucet(3, 2, None);
        let one = |network: Prefix, at: u64| faucet.admit(&Pubkey::new_unique(), network, at);
        assert_eq!(one(network(1), NOW), Ok(()));
        assert_eq!(one(network(1), NOW), Ok(()));
        assert_eq!(one(network(1), NOW), Err(Refusal::NetworkSpentToday));
        assert_eq!(one(network(2), NOW), Ok(()));
        assert_eq!(one(network(3), NOW), Err(Refusal::SpentToday));
        assert_eq!(one(network(3), NOW + 86_400), Ok(()));
    }

    #[test]
    fn a_claim_whose_mint_never_happened_is_given_back() {
        let faucet = faucet(1, 1, None);
        let wallet = Pubkey::new_unique();
        faucet.admit(&wallet, network(1), NOW).unwrap();
        assert_eq!(
            faucet.admit(&Pubkey::new_unique(), network(1), NOW),
            Err(Refusal::SpentToday)
        );
        faucet.release(&wallet, network(1));
        assert_eq!(faucet.admit(&wallet, network(1), NOW + 1), Ok(()));
    }

    #[test]
    fn the_record_survives_a_restart_and_forgets_what_is_a_day_old() {
        let directory = std::env::temp_dir().join(format!("faucet-{}", Pubkey::new_unique()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("faucet.json");
        let wallet = Pubkey::new_unique();
        faucet(10, 10, Some(&path))
            .admit(&wallet, network(1), NOW)
            .unwrap();
        let reopened = faucet(10, 10, Some(&path));
        assert!(matches!(
            reopened.admit(&wallet, network(1), NOW + 60),
            Err(Refusal::Wait(_))
        ));
        assert_eq!(
            reopened.admit(&wallet, network(1), NOW + WALLET_INTERVAL + 1),
            Ok(())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_record_that_cannot_be_read_stops_the_faucet_rather_than_forgetting_every_claim() {
        let directory = std::env::temp_dir().join(format!("faucet-{}", Pubkey::new_unique()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("faucet.json");
        fs::write(&path, b"{not json").unwrap();
        assert!(
            Faucet::open(
                Keypair::new(),
                crate::chain::TOKEN_PROGRAM,
                1,
                1,
                1,
                Some(&path)
            )
            .is_err()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_claim_that_cannot_be_written_down_is_not_served() {
        let faucet = faucet(
            10,
            10,
            Some(Path::new("/nonexistent-directory/faucet.json")),
        );
        assert_eq!(
            faucet.admit(&Pubkey::new_unique(), network(1), NOW),
            Err(Refusal::Unwritable)
        );
    }

    #[test]
    fn it_creates_the_token_account_if_missing_and_mints_the_amount_with_the_authority_as_signer() {
        let faucet = faucet(10, 10, None);
        let (payer, wallet, mint) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let [create, mint_to] = faucet.instructions(&payer, &wallet, &mint);
        let account =
            crate::chain::associated_token_address(&wallet, &mint, &crate::chain::TOKEN_PROGRAM);
        assert_eq!(create.program_id, ASSOCIATED_TOKEN_PROGRAM);
        assert_eq!(create.data, vec![1]);
        assert_eq!(create.accounts[0].pubkey, payer);
        assert!(create.accounts[0].is_signer);
        assert_eq!(create.accounts[1].pubkey, account);
        assert_eq!(create.accounts[2].pubkey, wallet);
        assert_eq!(mint_to.program_id, crate::chain::TOKEN_PROGRAM);
        assert_eq!(mint_to.data[0], 7);
        assert_eq!(&mint_to.data[1..], &20_000_000u64.to_le_bytes());
        assert_eq!(mint_to.accounts[1].pubkey, account);
        assert_eq!(mint_to.accounts[2].pubkey, faucet.authority.pubkey());
        assert!(mint_to.accounts[2].is_signer);
    }
}
