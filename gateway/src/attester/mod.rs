//! The first-party attester: a separate process that reads a lock at `finalized` from two
//! independent providers and signs exactly what it says, nothing else. It holds no fee payer, signs
//! no transaction and keeps no money.

pub mod limits;
pub mod plan;
pub mod reader;
pub mod server;
