#![no_std]

pub mod caveats;
pub mod cluster;
pub mod conflict;
pub mod device;
pub mod error;
pub use conflict::{IssueClaim, IssueConflict, SpendConflict};
pub mod message;
#[cfg(feature = "verify")]
pub mod verify;
pub use caveats::{flags, Caveats, Owner, ScopeKind, MAX_DEPTH};
pub use message::{kind, BondTicket, Issue, Outputs, Signed, Spend, CHALLENGE, GRACE, NO_LOCK};
pub mod hash;
pub mod lock;
pub mod profile;

pub use error::{ProtocolError, Result};

pub const VERSION: u8 = 1;

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_one() {
        assert_eq!(super::VERSION, 1);
    }
}
