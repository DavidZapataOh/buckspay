#![no_std]

extern crate alloc;

pub mod attest;
pub mod caveats;
pub mod chain;
pub mod cluster;
pub mod conflict;
pub mod device;
pub mod error;
pub use conflict::{IssueClaim, IssueConflict, SpendConflict};
pub mod message;
pub mod payword;
pub mod reclaim;
pub mod record;
pub mod secp256r1;
pub mod slash;
#[cfg(feature = "verify")]
pub mod ticket;
#[cfg(feature = "verify")]
pub mod verify;
pub use caveats::{flags, Caveats, Owner, ScopeKind, MAX_DEPTH};
pub use message::{kind, BondTicket, Issue, Outputs, Signed, Spend, CHALLENGE, GRACE, NO_LOCK};
pub mod hash;
pub mod iou;
pub mod lock;
pub mod netting;
pub mod profile;
pub mod window;

pub use error::{ProtocolError, Result};

pub const VERSION: u8 = 1;

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_one() {
        assert_eq!(super::VERSION, 1);
    }
}
