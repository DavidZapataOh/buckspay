//! What the phone reads to claim rewards: the leaves of an epoch's tree and the claim key on offer.
//! Both come from the chain on every request; the gateway keeps nothing of its own.

use crate::{
    channels::event_discriminator,
    onboard::read,
    rewards::{CLAIM_KEY_OVERLAP, SweepConfig, read_sweep_config},
    server::{Error, Gateway},
    settlements::Problem,
    sponsored::unreachable,
    zk::keys_body,
};
use axum::{
    Json,
    extract::{Path, State},
    http::header::{CONTENT_TYPE, HeaderValue},
    response::{IntoResponse, Response},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::accounts::{RewardConfig, RewardTree};
use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::GetConfirmedSignaturesForAddress2Config;
use solana_rpc_client_api::{
    config::RpcTransactionConfig, response::RpcConfirmedTransactionStatusWithSignature,
};
use solana_signature::Signature;
use solana_transaction_status_client_types::UiTransactionEncoding;
use std::{sync::Arc, time::Instant};
use tokio::task::JoinSet;
use tracing::info;

/// The most leaves one answer carries (512 KiB): a bigger tree is not served.
pub const MAX_LEAVES: u32 = 16_384;
const LEAF_BYTES: usize = 32;
const SIGNATURES_PER_PAGE: usize = 1_000;
const FETCHES_AT_ONCE: usize = 16;
/// The most transactions read for one answer.
const MAX_SCANNED: usize = 4 * MAX_LEAVES as usize;
const EVENT_LEN: usize = 8 + 4 + 4 + LEAF_BYTES + 1;

/// The size of an answer with `count` leaves, or none when that is more than is served.
pub fn body_len(count: u32) -> Option<usize> {
    if count > MAX_LEAVES {
        return None;
    }
    usize::try_from(count).ok()?.checked_mul(LEAF_BYTES)
}

/// `(index, leaf)` of every `LeafAppended` event of `epoch` that `program` itself logged.
pub fn appended(logs: &[String], program: &Pubkey, epoch: u32) -> Vec<(u32, [u8; 32])> {
    let discriminator = event_discriminator();
    let (invoke, program) = (" invoke [", program.to_string());
    let mut stack: Vec<&str> = Vec::new();
    let mut found = Vec::new();
    for line in logs {
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };
        if let Some(data) = rest.strip_prefix("data: ") {
            if stack.last() != Some(&program.as_str()) {
                continue;
            }
            let Ok(data) = BASE64_STANDARD.decode(data) else {
                continue;
            };
            if data.len() == EVENT_LEN && data[..8] == discriminator {
                let word = |at: usize| <[u8; 4]>::try_from(&data[at..at + 4]).ok();
                if let (Some(event_epoch), Some(index), Ok(leaf)) = (
                    word(8).map(u32::from_le_bytes),
                    word(12).map(u32::from_le_bytes),
                    <[u8; 32]>::try_from(&data[16..48]),
                ) && event_epoch == epoch
                {
                    found.push((index, leaf));
                }
            }
        } else if let Some((id, _)) = rest.split_once(invoke) {
            stack.push(id);
        } else if rest.ends_with(" success") || rest.contains(" failed: ") {
            stack.pop();
        }
    }
    found
}

/// Fills `slots` from `events`, keeping the first leaf seen at an index; returns how many it filled.
pub fn place(slots: &mut [Option<[u8; 32]>], events: &[(u32, [u8; 32])]) -> usize {
    let mut filled = 0;
    for (index, leaf) in events {
        if let Some(slot) = usize::try_from(*index)
            .ok()
            .and_then(|index| slots.get_mut(index))
            && slot.is_none()
        {
            *slot = Some(*leaf);
            filled += 1;
        }
    }
    filled
}

/// `GET /v1/rewards/trees/{epoch}`: the leaves of the epoch's tree from index 0, 32 bytes each.
pub(crate) async fn tree(State(state): State<Arc<Gateway>>, Path(epoch): Path<u32>) -> Response {
    let started = Instant::now();
    let result = leaves(&state, epoch).await.map(|body| {
        (
            [(
                CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            )],
            body,
        )
            .into_response()
    });
    logged("tree", started, result)
}

/// `GET /v1/rewards/key`: the claim key the program holds, and the previous one while it is accepted.
pub(crate) async fn key(State(state): State<Arc<Gateway>>) -> Response {
    let started = Instant::now();
    logged(
        "key",
        started,
        offer(&state).await.map(|body| Json(body).into_response()),
    )
}

/// `GET /v1/sweeps/quote`: the budget and the fee a sweep must carry, from the numbers the sweep check enforces.
pub(crate) async fn sweep_quote(State(state): State<Arc<Gateway>>) -> Response {
    let started = Instant::now();
    logged(
        "sweep_quote",
        started,
        quote(&state).await.map(|body| Json(body).into_response()),
    )
}

async fn quote(state: &Gateway) -> Result<serde_json::Value, Error> {
    if state.rewards.rate.is_none() {
        return Err(Error::BadRequest("the reward rate is not set here"));
    }
    Ok(quote_body(&read_sweep_config(state).await?))
}

fn quote_body(cfg: &SweepConfig) -> serde_json::Value {
    serde_json::json!({
        "gateway": cfg.gateway.to_string(),
        "feeAccount": cfg.fee_account.to_string(),
        "fee": cfg.sweep_fee.to_string(),
        "feeWithAccount": cfg.sweep_fee_with_ata.to_string(),
        "computeUnitLimit": cfg.pinned.sweep_cu,
        "computeUnitPrice": cfg.pinned.priority_price.to_string(),
    })
}

fn logged(route: &str, started: Instant, result: Result<Response, Error>) -> Response {
    let (response, code) = match result {
        Ok(response) => (response, "ok".to_owned()),
        Err(error) => {
            let code = error.code();
            (error.into_response(), code)
        }
    };
    info!(
        route,
        status = response.status().as_u16(),
        code,
        elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "reward read answered"
    );
    response
}

async fn offer(state: &Gateway) -> Result<serde_json::Value, Error> {
    let program = state.settings.program;
    let base = state
        .zk
        .keys_url
        .as_deref()
        .ok_or(Error::BadRequest("the key files are not published here"))?;
    let address = Pubkey::find_program_address(&[b"reward-config"], &program.id()).0;
    let account = read(state, &[address])
        .await?
        .remove(0)
        .filter(|account| account.owner == program.id())
        .ok_or(Error::Settlement(Problem::Paused))?;
    let config = RewardConfig::from_bytes(&account.data).map_err(|_| Error::Upstream)?;
    Ok(offer_of(&config, base))
}

/// The current claim key as the answer, with the previous one under `previous` while a rotation is recent.
fn offer_of(config: &RewardConfig, base: &str) -> serde_json::Value {
    let mut keys = keys_body(
        &config.claim_key,
        &config.previous_claim_key,
        config.rotated_at,
        base,
        CLAIM_KEY_OVERLAP,
    );
    let mut offer = keys["current"].take();
    if let Some(previous) = keys.get_mut("previous") {
        offer["previous"] = previous.take();
    }
    offer
}

/// The signatures of the transactions that succeeded: a failed one changed nothing on the chain.
fn landed(page: &[RpcConfirmedTransactionStatusWithSignature]) -> Vec<Signature> {
    page.iter()
        .filter(|entry| entry.err.is_none())
        .filter_map(|entry| entry.signature.parse().ok())
        .collect()
}

async fn leaves(state: &Arc<Gateway>, epoch: u32) -> Result<Vec<u8>, Error> {
    let (program, mint) = (state.settings.program, state.settings.mint);
    let address = Pubkey::find_program_address(
        &[b"reward-tree", mint.as_ref(), &epoch.to_le_bytes()],
        &program.id(),
    )
    .0;
    let account = read(state, &[address])
        .await?
        .remove(0)
        .filter(|account| account.owner == program.id())
        .ok_or(Error::NotFound("this epoch has no reward tree"))?;
    let tree = RewardTree::from_bytes(&account.data).map_err(|_| Error::Upstream)?;
    if tree.mint != mint || tree.epoch != epoch {
        return Err(Error::Upstream);
    }
    body_len(tree.next_index).ok_or(Error::Upstream)?;
    let mut slots = vec![None; usize::try_from(tree.next_index).map_err(|_| Error::Upstream)?];
    let mut missing = slots.len();
    let (mut before, mut scanned) = (None, 0usize);
    while missing > 0 && scanned < MAX_SCANNED {
        let page = state
            .rpc
            .get_signatures_for_address_with_config(
                &address,
                GetConfirmedSignaturesForAddress2Config {
                    before,
                    until: None,
                    limit: Some(SIGNATURES_PER_PAGE),
                    commitment: Some(state.rpc.commitment()),
                },
            )
            .await
            .map_err(unreachable)?;
        let Some(last) = page.last() else {
            break;
        };
        before = last.signature.parse::<Signature>().ok();
        scanned = scanned.saturating_add(page.len());
        let landed = landed(&page);
        for batch in landed.chunks(FETCHES_AT_ONCE) {
            let mut fetches = JoinSet::new();
            for signature in batch {
                fetches.spawn(events_of(Arc::clone(state), *signature, epoch));
            }
            while let Some(done) = fetches.join_next().await {
                let events = done.map_err(|_| Error::Upstream)??;
                missing -= place(&mut slots, &events);
            }
            if missing == 0 {
                break;
            }
        }
        if before.is_none() {
            break;
        }
    }
    if missing > 0 {
        return Err(Error::Upstream);
    }
    Ok(slots.into_iter().flatten().flatten().collect())
}

async fn events_of(
    state: Arc<Gateway>,
    signature: Signature,
    epoch: u32,
) -> Result<Vec<(u32, [u8; 32])>, Error> {
    let fetched = state
        .rpc
        .get_transaction_with_config(
            &signature,
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Base64),
                commitment: Some(state.rpc.commitment()),
                max_supported_transaction_version: Some(1),
            },
        )
        .await
        .map_err(unreachable)?;
    let logs = fetched
        .transaction
        .meta
        .and_then(|meta| Option::<Vec<String>>::from(meta.log_messages))
        .unwrap_or_default();
    Ok(appended(&logs, &state.settings.program.id(), epoch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn event(epoch: u32, index: u32, leaf: u8) -> String {
        let mut data = Sha256::digest(b"event:LeafAppended")[..8].to_vec();
        data.extend(epoch.to_le_bytes());
        data.extend(index.to_le_bytes());
        data.extend([leaf; 32]);
        data.push(1);
        format!("Program data: {}", BASE64_STANDARD.encode(data))
    }

    fn lines(program: &Pubkey, body: &[String]) -> Vec<String> {
        let mut logs = vec![format!("Program {program} invoke [1]")];
        logs.extend(body.iter().cloned());
        logs.push(format!("Program {program} success"));
        logs
    }

    #[test]
    fn an_answer_is_at_most_max_leaves_of_32_bytes() {
        assert_eq!(body_len(0), Some(0));
        assert_eq!(body_len(1), Some(32));
        assert_eq!(body_len(MAX_LEAVES), Some(MAX_LEAVES as usize * 32));
        assert_eq!(body_len(MAX_LEAVES + 1), None);
        assert_eq!(body_len(u32::MAX), None);
    }

    #[test]
    fn events_of_the_program_and_the_epoch_are_read() {
        let program = Pubkey::new_unique();
        let logs = lines(&program, &[event(3, 7, 9), event(4, 8, 5), event(3, 9, 6)]);
        assert_eq!(
            appended(&logs, &program, 3),
            vec![(7, [9; 32]), (9, [6; 32])]
        );
    }

    #[test]
    fn an_event_another_program_logged_is_ignored() {
        let (program, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let logs = vec![
            format!("Program {other} invoke [1]"),
            event(3, 7, 9),
            format!("Program {other} success"),
            format!("Program {program} invoke [1]"),
            format!("Program {other} invoke [2]"),
            event(3, 8, 9),
            format!("Program {other} success"),
            event(3, 9, 4),
            format!("Program {program} success"),
        ];
        assert_eq!(appended(&logs, &program, 3), vec![(9, [4; 32])]);
    }

    fn keys(n: u8) -> buckspay_client::types::KeyHashes {
        buckspay_client::types::KeyHashes {
            vk: [n; 32],
            pk: [n + 1; 32],
            dump: [n + 2; 32],
            ccs: [n + 3; 32],
        }
    }

    fn config(rotated_at: i64) -> RewardConfig {
        RewardConfig {
            discriminator: [0; 8],
            admin: Pubkey::new_unique(),
            pauser: Pubkey::new_unique(),
            paused: false,
            claim_key: keys(10),
            previous_claim_key: keys(20),
            rotated_at,
            bump: 255,
        }
    }

    #[test]
    fn the_offer_is_the_current_key_and_names_the_previous_one_after_a_rotation() {
        let fresh = offer_of(&config(0), "https://k");
        assert_eq!(fresh["vkSha256"], hex::encode([10u8; 32]));
        assert_eq!(
            fresh["pkUrl"],
            format!("https://k/zk/{}/pk.bin", hex::encode([10u8; 32]))
        );
        assert!(fresh.get("previous").is_none());
        let rotated = offer_of(&config(5_000), "https://k");
        assert_eq!(rotated["vkSha256"], hex::encode([10u8; 32]));
        assert_eq!(rotated["previous"]["vkSha256"], hex::encode([20u8; 32]));
        assert_eq!(
            rotated["previous"]["validUntil"],
            5_000 + i64::from(CLAIM_KEY_OVERLAP)
        );
        assert_eq!(CLAIM_KEY_OVERLAP, 262_800);
    }

    #[test]
    fn a_failed_transaction_is_not_read() {
        let entry = |n: u8, err| RpcConfirmedTransactionStatusWithSignature {
            signature: Signature::from([n; 64]).to_string(),
            slot: 1,
            err,
            memo: None,
            block_time: None,
            confirmation_status: None,
            transaction_index: None,
        };
        let page = vec![
            entry(1, None),
            entry(
                2,
                Some(solana_transaction_error::TransactionError::AccountInUse.into()),
            ),
        ];
        assert_eq!(landed(&page), vec![page[0].signature.parse().unwrap()]);
    }

    #[test]
    fn malformed_data_is_skipped() {
        let program = Pubkey::new_unique();
        let logs = lines(
            &program,
            &[
                "Program data: not base64!".into(),
                "Program data: AAAA".into(),
            ],
        );
        assert!(appended(&logs, &program, 0).is_empty());
    }

    #[test]
    fn a_leaf_is_placed_once_and_only_inside_the_tree() {
        let mut slots = vec![None; 3];
        let events = [
            (1, [1; 32]),
            (1, [2; 32]),
            (3, [3; 32]),
            (u32::MAX, [4; 32]),
            (0, [5; 32]),
        ];
        assert_eq!(place(&mut slots, &events), 2);
        assert_eq!(slots, vec![Some([5; 32]), Some([1; 32]), None]);
    }
}
