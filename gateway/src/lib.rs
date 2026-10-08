//! Buckspay's gateway: sponsors onboarding, locks, withdrawals and wallet rotations without holding
//! user funds or keys.

pub mod attester;
pub mod batches;
pub mod chain;
pub mod channels;
pub mod claims;
pub mod config;
pub mod fees;
pub mod float;
pub mod group_settlements;
pub mod hpke;
pub mod janitor;
pub mod jobs;
pub mod limits;
pub mod message;
pub mod nettings;
pub mod onboard;
pub mod operations;
pub mod relay;
pub mod reward_reads;
pub mod rewards;
pub mod server;
pub mod settlements;
pub mod sponsor;
pub mod sponsored;
pub mod transactions;
pub mod words;
pub mod zk;
