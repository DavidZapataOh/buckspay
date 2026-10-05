#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    Length,
    Version,
    Kind,
    Owner,
    Flags,
    ScopeKind,
    Scope,
    Amount,
    Depth,
    Attenuation,
    Linkage,
    Signer,
    Signature,
    Expired,
    Change,
    Lock,
    Ticket,
    Window,
    Payee,
    ExpiryStep,
    Unrecordable,
}

pub type Result<T> = core::result::Result<T, ProtocolError>;
