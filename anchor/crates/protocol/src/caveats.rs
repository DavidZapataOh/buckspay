use solana_sha256_hasher::hashv;

use crate::{ProtocolError, Result};

pub const MAX_DEPTH: u8 = 16;
const SCOPE_TAG: &[u8] = b"BPS1";

pub mod flags {
    pub const DELEGATED: u8 = 1;
    pub const AUTHORITY_ONLY: u8 = 2;
    pub const STICKY: u8 = AUTHORITY_ONLY;
    pub const KNOWN: u8 = DELEGATED | AUTHORITY_ONLY;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Device([u8; 33]),
    Account([u8; 32]),
}

impl Owner {
    pub const LEN: usize = 33;

    pub fn encode(&self) -> [u8; 33] {
        match self {
            Owner::Device(key) => *key,
            Owner::Account(account) => {
                let mut out = [0; 33];
                out[1..].copy_from_slice(account);
                out
            }
        }
    }

    pub fn decode(bytes: &[u8; 33]) -> Result<Owner> {
        match bytes[0] {
            0x02 | 0x03 => Ok(Owner::Device(*bytes)),
            0x00 => {
                let mut account = [0; 32];
                account.copy_from_slice(&bytes[1..]);
                Ok(Owner::Account(account))
            }
            _ => Err(ProtocolError::Owner),
        }
    }

    pub fn scope_hash(&self) -> [u8; 20] {
        let digest = hashv(&[SCOPE_TAG, &self.encode()]).to_bytes();
        let mut out = [0; 20];
        out.copy_from_slice(&digest[..20]);
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ScopeKind {
    Any = 0,
    Merchant = 1,
    Category = 2,
    Authority = 3,
}

impl TryFrom<u8> for ScopeKind {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(ScopeKind::Any),
            1 => Ok(ScopeKind::Merchant),
            2 => Ok(ScopeKind::Category),
            3 => Ok(ScopeKind::Authority),
            _ => Err(ProtocolError::ScopeKind),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caveats {
    pub expiry: u32,
    pub hops_left: u8,
    pub flags: u8,
    pub scope_kind: ScopeKind,
    pub scope: [u8; 20],
}

impl Caveats {
    pub const LEN: usize = 27;

    pub fn encode(&self) -> [u8; 27] {
        let mut out = [0; 27];
        out[..4].copy_from_slice(&self.expiry.to_le_bytes());
        out[4] = self.hops_left;
        out[5] = self.flags;
        out[6] = self.scope_kind as u8;
        out[7..].copy_from_slice(&self.scope);
        out
    }

    pub fn decode(bytes: &[u8; 27]) -> Result<Caveats> {
        let mut scope = [0; 20];
        scope.copy_from_slice(&bytes[7..]);
        let caveats = Caveats {
            expiry: u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            hops_left: bytes[4],
            flags: bytes[5],
            scope_kind: ScopeKind::try_from(bytes[6])?,
            scope,
        };
        caveats.check()?;
        Ok(caveats)
    }

    pub fn check(&self) -> Result<()> {
        if self.flags & !flags::KNOWN != 0 {
            return Err(ProtocolError::Flags);
        }
        let canonical = match self.scope_kind {
            ScopeKind::Any => self.scope == [0; 20],
            ScopeKind::Category => self.scope[2..] == [0; 18],
            ScopeKind::Merchant | ScopeKind::Authority => true,
        };
        let authority_only = self.flags & flags::AUTHORITY_ONLY != 0;
        if !canonical || (authority_only && self.scope_kind != ScopeKind::Authority) {
            return Err(ProtocolError::Scope);
        }
        Ok(())
    }

    pub fn permits(&self, child: &Caveats) -> bool {
        self.hops_left >= 1
            && child.hops_left < self.hops_left
            && child.expiry <= self.expiry
            && child.flags & flags::STICKY == self.flags & flags::STICKY
            && (self.scope_kind == ScopeKind::Any
                || (child.scope_kind == self.scope_kind && child.scope == self.scope))
    }

    pub fn admits(&self, payee: &Owner) -> bool {
        match self.scope_kind {
            ScopeKind::Merchant | ScopeKind::Authority => payee.scope_hash() == self.scope,
            ScopeKind::Any | ScopeKind::Category => true,
        }
    }

    /// The caveats a spend by `holder` must obey. A merchant scope that names `holder` has
    /// reached its party, so it no longer binds that spend. An authority scope is never lifted:
    /// the authority is a terminal account, and its outputs are never spent.
    pub fn for_holder(&self, holder: &Owner) -> Caveats {
        if self.scope_kind != ScopeKind::Merchant || holder.scope_hash() != self.scope {
            return *self;
        }
        Caveats {
            scope_kind: ScopeKind::Any,
            scope: [0; 20],
            ..*self
        }
    }

    /// An authority is a terminal account, so an output whose authority scope names its own
    /// owner must be owned by an account (`Scope`).
    pub fn check_holder(&self, owner: &Owner) -> Result<()> {
        let device_authority = self.scope_kind == ScopeKind::Authority
            && matches!(owner, Owner::Device(_))
            && owner.scope_hash() == self.scope;
        if device_authority {
            return Err(ProtocolError::Scope);
        }
        Ok(())
    }

    /// Change keeps the input's caveats with one hop less, and must itself stay spendable.
    pub fn change(&self) -> Result<Caveats> {
        if self.hops_left < 2 {
            return Err(ProtocolError::Depth);
        }
        Ok(Caveats {
            hops_left: self.hops_left - 1,
            ..*self
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn caveats(expiry: u32, hops_left: u8, flags: u8, scope_kind: ScopeKind) -> Caveats {
        let scope = if scope_kind == ScopeKind::Any {
            [0; 20]
        } else {
            [9; 20]
        };
        Caveats {
            expiry,
            hops_left,
            flags,
            scope_kind,
            scope,
        }
    }

    fn device(tag: u8) -> Owner {
        let mut key = [tag; 33];
        key[0] = 0x02;
        Owner::Device(key)
    }

    #[test]
    fn owner_rejects_reserved_type() {
        let mut bytes = [0; 33];
        bytes[0] = 0x01;
        assert_eq!(Owner::decode(&bytes), Err(ProtocolError::Owner));
    }

    #[test]
    fn owner_account_requires_zero_prefix() {
        let owner = Owner::Account([5; 32]);
        assert_eq!(Owner::decode(&owner.encode()), Ok(owner));
    }

    #[test]
    fn caveats_reject_unknown_flags() {
        let mut bytes = caveats(1, 1, 0, ScopeKind::Any).encode();
        bytes[5] = 0b100;
        assert_eq!(Caveats::decode(&bytes), Err(ProtocolError::Flags));
    }

    #[test]
    fn caveats_reject_unknown_scope_kind() {
        let mut bytes = caveats(1, 1, 0, ScopeKind::Any).encode();
        bytes[6] = 4;
        assert_eq!(Caveats::decode(&bytes), Err(ProtocolError::ScopeKind));
    }

    #[test]
    fn caveats_reject_non_canonical_scope() {
        let mut any = caveats(1, 1, 0, ScopeKind::Any);
        any.scope[19] = 1;
        let mut category = caveats(1, 1, 0, ScopeKind::Category);
        category.scope = [0; 20];
        category.scope[..2].copy_from_slice(&7u16.to_le_bytes());
        assert_eq!(Caveats::decode(&category.encode()), Ok(category));
        category.scope[2] = 1;
        let merchant_only = caveats(1, 1, flags::AUTHORITY_ONLY, ScopeKind::Merchant);
        for bad in [any, category, merchant_only] {
            assert_eq!(Caveats::decode(&bad.encode()), Err(ProtocolError::Scope));
        }
    }

    #[test]
    fn exhausted_parent_permits_nothing() {
        let parent = caveats(10, 0, 0, ScopeKind::Any);
        assert!(!parent.permits(&caveats(10, 0, 0, ScopeKind::Any)));
    }

    #[test]
    fn scoped_parent_requires_same_scope() {
        let parent = caveats(10, 3, 0, ScopeKind::Merchant);
        let mut other = caveats(10, 2, 0, ScopeKind::Merchant);
        other.scope = [8; 20];
        assert!(parent.permits(&caveats(10, 2, 0, ScopeKind::Merchant)));
        assert!(!parent.permits(&other));
        assert!(!parent.permits(&caveats(10, 2, 0, ScopeKind::Any)));
    }

    #[test]
    fn merchant_and_authority_scopes_admit_only_their_key() {
        let merchant = device(3);
        for kind in [ScopeKind::Merchant, ScopeKind::Authority] {
            let scoped = Caveats {
                scope: merchant.scope_hash(),
                ..caveats(10, 3, 0, kind)
            };
            assert!(scoped.admits(&merchant));
            assert!(!scoped.admits(&device(4)));
            assert!(!scoped.admits(&Owner::Account([3; 32])));
        }
        assert!(caveats(10, 3, 0, ScopeKind::Any).admits(&device(4)));
        assert!(caveats(10, 3, 0, ScopeKind::Category).admits(&device(4)));
    }

    #[test]
    fn only_a_merchant_scope_is_lifted_for_its_party() {
        let merchant = device(3);
        let scoped = Caveats {
            scope: merchant.scope_hash(),
            ..caveats(10, 3, flags::DELEGATED, ScopeKind::Merchant)
        };
        assert_eq!(scoped.for_holder(&device(4)), scoped);
        let lifted = scoped.for_holder(&merchant);
        assert_eq!(lifted, caveats(10, 3, flags::DELEGATED, ScopeKind::Any));
        assert!(lifted.permits(&caveats(10, 2, 0, ScopeKind::Any)));
        assert!(lifted.admits(&Owner::Account([3; 32])));
        let authority = Owner::Account([3; 32]);
        for flags in [0, flags::AUTHORITY_ONLY] {
            let scoped = Caveats {
                scope: authority.scope_hash(),
                ..caveats(10, 3, flags, ScopeKind::Authority)
            };
            assert_eq!(scoped.for_holder(&authority), scoped);
        }
        let category = caveats(10, 3, 0, ScopeKind::Category);
        assert_eq!(category.for_holder(&merchant), category);
    }

    #[test]
    fn sticky_flags_are_set_only_by_the_issuer() {
        let open = caveats(10, 3, 0, ScopeKind::Authority);
        let closed = caveats(10, 3, flags::AUTHORITY_ONLY, ScopeKind::Authority);
        assert!(!open.permits(&closed.change().unwrap()));
        assert!(!caveats(10, 3, 0, ScopeKind::Any).permits(&closed.change().unwrap()));
        assert!(!closed.permits(&open.change().unwrap()));
        assert!(closed.permits(&closed.change().unwrap()));
    }

    #[test]
    fn an_authority_is_never_a_device() {
        let account = Owner::Account([3; 32]);
        for owner in [account, device(3)] {
            let authority = Caveats {
                scope: owner.scope_hash(),
                ..caveats(10, 3, flags::AUTHORITY_ONLY, ScopeKind::Authority)
            };
            let merchant = Caveats {
                flags: 0,
                scope_kind: ScopeKind::Merchant,
                ..authority
            };
            assert_eq!(merchant.check_holder(&owner), Ok(()));
            assert_eq!(authority.check_holder(&device(4)), Ok(()));
            let expected = match owner {
                Owner::Account(_) => Ok(()),
                Owner::Device(_) => Err(ProtocolError::Scope),
            };
            assert_eq!(authority.check_holder(&owner), expected);
            let open = Caveats {
                flags: 0,
                ..authority
            };
            assert_eq!(open.check_holder(&owner), expected);
        }
    }

    #[test]
    fn change_drops_one_hop_and_keeps_everything_else() {
        let parent = caveats(10, 3, flags::AUTHORITY_ONLY, ScopeKind::Authority);
        assert_eq!(
            parent.change(),
            Ok(caveats(10, 2, flags::AUTHORITY_ONLY, ScopeKind::Authority))
        );
        for hops_left in [0, 1] {
            assert_eq!(
                caveats(10, hops_left, 0, ScopeKind::Any).change(),
                Err(ProtocolError::Depth)
            );
        }
    }

    fn any_caveats() -> impl Strategy<Value = Caveats> {
        (
            any::<u32>(),
            0..=MAX_DEPTH,
            0..=flags::KNOWN,
            0u8..4,
            any::<[u8; 20]>(),
        )
            .prop_map(|(expiry, hops_left, flags, kind, mut scope)| {
                let scope_kind = ScopeKind::try_from(kind).unwrap();
                match scope_kind {
                    ScopeKind::Any => scope = [0; 20],
                    ScopeKind::Category => scope[2..].fill(0),
                    ScopeKind::Merchant | ScopeKind::Authority => {}
                }
                let flags = match scope_kind {
                    ScopeKind::Authority => flags,
                    _ => flags & flags::DELEGATED,
                };
                Caveats {
                    expiry,
                    hops_left,
                    flags,
                    scope_kind,
                    scope,
                }
            })
    }

    proptest! {
        #[test]
        fn caveats_round_trip(c in any_caveats()) {
            prop_assert_eq!(Caveats::decode(&c.encode()), Ok(c));
        }

        #[test]
        fn permitted_children_never_widen(parent in any_caveats(), child in any_caveats()) {
            if parent.permits(&child) {
                prop_assert!(child.expiry <= parent.expiry);
                prop_assert!(child.hops_left < parent.hops_left);
                prop_assert_eq!(child.flags & flags::STICKY, parent.flags & flags::STICKY);
                if parent.scope_kind != ScopeKind::Any {
                    prop_assert_eq!(child.scope_kind, parent.scope_kind);
                    prop_assert_eq!(child.scope, parent.scope);
                }
            }
        }

        #[test]
        fn attenuation_is_transitive(a in any_caveats(), b in any_caveats(), c in any_caveats()) {
            if a.permits(&b) && b.permits(&c) {
                prop_assert!(c.expiry <= a.expiry && c.hops_left < a.hops_left);
            }
        }
    }
}
