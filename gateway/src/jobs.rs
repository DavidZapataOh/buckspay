//! The settlements the gateway has started and has to finish. A chain that needs several
//! transactions is written down before its first send, and the janitor resumes it until it ends:
//! the last batch landed, a conflict, a permanent refusal by the program, or the close of the
//! window. What each pass sends is derived from the records on chain, never from the counter here.
use crate::float::Prefix;
use buckspay_client::errors::BuckspayError as E;
use serde::{Deserialize, Serialize};
use solana_instruction_error::InstructionError;
use solana_transaction_error::TransactionError;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

/// Seconds an ended job is kept before it is forgotten.
const KEEP_ENDED: u32 = 86_400;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    Pending,
    Done,
    /// Another message already consumed an output of the chain: a claim is the way on.
    Conflict,
    /// The window of the last consumed output, or the lock, closed.
    Expired,
    /// The program refuses the chain for good: nothing the gateway can send changes that.
    Refused,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SettlementJob {
    pub key: String,
    pub issue: String,
    pub spends: Vec<String>,
    pub prefix: Prefix,
    pub created_at: u32,
    /// The second after which no batch can land: the window of the last consumed output, or the
    /// end of the lock if that comes first.
    pub deadline: u32,
    pub batches_done: u8,
    pub state: JobState,
    /// The last transaction sent and the last block height it can land at: nothing is sent again
    /// before it has landed or can no longer land.
    pub last_signature: Option<String>,
    pub last_valid_block_height: Option<u64>,
    /// The second before which a relayed job is not sent: the gateway's random delay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<u32>,
    /// The private settlement the job finishes, in place of `issue` and `spends`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zk: Option<crate::zk::ZkRequest>,
}

/// The state a failed simulation of a batch puts a job in, when it is not transient.
pub fn verdict(failure: &TransactionError) -> Option<JobState> {
    let TransactionError::InstructionError(_, InstructionError::Custom(code)) = failure else {
        return None;
    };
    let is = |error: E| *code == error as u32;
    if is(E::ConflictingSpend) {
        Some(JobState::Conflict)
    } else if [
        E::WrongPayee,
        E::ChainInvalid,
        E::ProofRejected,
        E::StaleVerifyingKey,
        E::NonCanonicalPublic,
        E::BelowRecordFee,
        E::LockEnded,
        E::SettlementClosed,
        E::WrongLock,
        E::TooManySpends,
        E::ChainVerification,
    ]
    .into_iter()
    .any(is)
    {
        Some(JobState::Refused)
    } else {
        None
    }
}

#[derive(Default)]
pub struct Jobs {
    path: Option<PathBuf>,
    rows: Mutex<BTreeMap<String, SettlementJob>>,
    driving: Mutex<HashSet<String>>,
}

/// Held while one task sends the batches of a job, so that a request and the janitor never send
/// the same batch.
pub struct Driving<'a> {
    jobs: &'a Jobs,
    key: String,
}

impl Drop for Driving<'_> {
    fn drop(&mut self) {
        self.jobs.driving.lock().unwrap().remove(&self.key);
    }
}

impl Jobs {
    pub fn open(path: &Path) -> Result<Self, String> {
        let rows = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self {
            path: Some(path.to_owned()),
            rows: Mutex::new(rows),
            driving: Mutex::default(),
        })
    }

    pub fn drive(&self, key: &str) -> Option<Driving<'_>> {
        self.driving
            .lock()
            .unwrap()
            .insert(key.to_owned())
            .then(|| Driving {
                jobs: self,
                key: key.to_owned(),
            })
    }

    pub fn get(&self, key: &str) -> Option<SettlementJob> {
        self.rows.lock().unwrap().get(key).cloned()
    }

    /// The jobs still to be finished.
    pub fn pending(&self) -> Vec<SettlementJob> {
        self.rows
            .lock()
            .unwrap()
            .values()
            .filter(|job| job.state == JobState::Pending)
            .cloned()
            .collect()
    }

    /// Writes a job down before its first send, atomically: a job that exists is left as it is and
    /// `false` says this call did not write it.
    pub fn begin(&self, job: SettlementJob) -> io::Result<bool> {
        let mut rows = self.rows.lock().unwrap();
        let now = job.created_at;
        rows.retain(|_, row| {
            row.state == JobState::Pending || row.deadline.saturating_add(KEEP_ENDED) > now
        });
        if rows.contains_key(&job.key) {
            return Ok(false);
        }
        rows.insert(job.key.clone(), job);
        self.save(&rows)?;
        Ok(true)
    }

    /// The transaction about to be sent, written before the send.
    pub fn sent(&self, key: &str, signature: &str, last_valid_block_height: u64) -> io::Result<()> {
        self.update(key, |job| {
            job.last_signature = Some(signature.to_owned());
            job.last_valid_block_height = Some(last_valid_block_height);
        })
    }

    /// A batch landed.
    pub fn landed(&self, key: &str) -> io::Result<()> {
        self.update(key, |job| {
            job.batches_done = job.batches_done.saturating_add(1);
            job.last_signature = None;
            job.last_valid_block_height = None;
        })
    }

    /// Ends a job: it is never sent again. A job that is not written down is not tracked.
    pub fn end(&self, key: &str, state: JobState) -> io::Result<()> {
        self.update(key, |job| job.state = state)
    }

    fn update(&self, key: &str, change: impl FnOnce(&mut SettlementJob)) -> io::Result<()> {
        let mut rows = self.rows.lock().unwrap();
        match rows.get_mut(key) {
            Some(job) if job.state == JobState::Pending => change(job),
            _ => return Ok(()),
        }
        self.save(&rows)
    }

    /// A write goes to a temporary file in the same directory, is synced, replaces the file by
    /// rename and syncs the directory: a power loss leaves the old jobs or the new ones.
    fn save(&self, rows: &MutexGuard<'_, BTreeMap<String, SettlementJob>>) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let dir = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(&serde_json::to_vec(&**rows).map_err(io::Error::other)?)?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|e| e.error)?;
        fs::File::open(dir)?.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(key: &str) -> SettlementJob {
        SettlementJob {
            key: key.to_owned(),
            issue: "aa".into(),
            spends: vec!["bb".into()],
            prefix: Prefix::V4([10, 0, 0]),
            created_at: 1_000,
            deadline: 5_000,
            batches_done: 0,
            state: JobState::Pending,
            last_signature: None,
            last_valid_block_height: None,
            not_before: None,
            zk: None,
        }
    }

    fn custom(error: E) -> TransactionError {
        TransactionError::InstructionError(1, InstructionError::Custom(error as u32))
    }

    #[test]
    fn a_job_written_down_survives_a_restart_with_what_was_sent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jobs.json");
        let jobs = Jobs::open(&path).unwrap();
        jobs.begin(job("a")).unwrap();
        jobs.sent("a", "sig", 77).unwrap();
        let reopened = Jobs::open(&path).unwrap();
        let back = reopened.get("a").unwrap();
        assert_eq!(back.last_signature.as_deref(), Some("sig"));
        assert_eq!(back.last_valid_block_height, Some(77));
        reopened.landed("a").unwrap();
        assert_eq!(reopened.get("a").unwrap().batches_done, 1);
        assert_eq!(reopened.get("a").unwrap().last_signature, None);
    }

    #[test]
    fn an_ended_job_is_never_sent_again_and_cannot_be_revived() {
        let jobs = Jobs::default();
        jobs.begin(job("a")).unwrap();
        jobs.end("a", JobState::Refused).unwrap();
        assert!(jobs.pending().is_empty());
        jobs.sent("a", "late", 1).unwrap();
        assert_eq!(jobs.get("a").unwrap().last_signature, None);
        jobs.begin(job("a")).unwrap();
        assert_eq!(jobs.get("a").unwrap().state, JobState::Refused);
    }

    #[test]
    fn one_task_drives_a_job_at_a_time() {
        let jobs = Jobs::default();
        let first = jobs.drive("a").unwrap();
        assert!(jobs.drive("a").is_none());
        assert!(jobs.drive("b").is_some());
        drop(first);
        assert!(jobs.drive("a").is_some());
    }

    #[test]
    fn an_ended_job_is_forgotten_after_a_day() {
        let jobs = Jobs::default();
        jobs.begin(job("old")).unwrap();
        jobs.end("old", JobState::Done).unwrap();
        let mut later = job("new");
        later.created_at = 5_000 + KEEP_ENDED;
        jobs.begin(later).unwrap();
        assert!(jobs.get("old").is_none());
        assert!(jobs.get("new").is_some());
    }

    #[test]
    fn what_the_program_refuses_for_good_ends_the_job() {
        assert_eq!(
            verdict(&custom(E::ConflictingSpend)),
            Some(JobState::Conflict)
        );
        for refused in [
            E::WrongPayee,
            E::ChainInvalid,
            E::LockEnded,
            E::SettlementClosed,
            E::WrongLock,
        ] {
            assert_eq!(verdict(&custom(refused)), Some(JobState::Refused));
        }
        assert_eq!(verdict(&custom(E::AmountZero)), None);
        assert_eq!(verdict(&TransactionError::BlockhashNotFound), None);
    }
}
