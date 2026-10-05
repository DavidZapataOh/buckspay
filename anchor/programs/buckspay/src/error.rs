use anchor_lang::prelude::*;

/// The codes of the first two variants never change; new ones are only appended.
#[error_code]
pub enum BuckspayError {
    #[msg("Device key is not a compressed P-256 point")]
    DeviceKey,
    #[msg("Missing or malformed secp256r1 verification of the device binding")]
    DeviceBinding,
    #[msg("lock_seq is not the device's next lock sequence number")]
    LockSeqMismatch,
    #[msg("The device has used every lock sequence number")]
    LockSeqExhausted,
    #[msg("Amount must be greater than zero")]
    AmountZero,
    #[msg("Amount overflows")]
    AmountOverflow,
    #[msg("lock_until is too close")]
    LockTooShort,
    #[msg("lock_until is too far")]
    LockTooLong,
    #[msg("The cluster clock is outside the supported range")]
    ClockOutOfRange,
    #[msg("The mint has an extension the program does not support")]
    UnsupportedMintExtension,
    #[msg("A sponsor fee is only allowed on a sponsored first lock")]
    FeeNotAllowed,
    #[msg("The sponsor fee is above its cap")]
    FeeTooHigh,
    #[msg("The lock cannot be withdrawn yet")]
    WithdrawTooEarly,
    #[msg("The lock cannot be released yet")]
    ReleaseTooEarly,
    #[msg("The lock cannot be closed yet")]
    CloseTooEarly,
    #[msg("The lock has not been withdrawn")]
    NotWithdrawn,
    #[msg("The escrow is still open")]
    EscrowOpen,
    #[msg("A slash is still pending in the lock")]
    SlashPending,
    #[msg("The escrow holds less than the ledger owes")]
    InsufficientEscrow,
    #[msg("Missing or malformed secp256r1 verification of the wallet rotation")]
    RotationBinding,
    #[msg("The wallet rotation cannot be applied yet")]
    RotationNotReady,
    #[msg("The new wallet is the current wallet")]
    SameWallet,
    #[msg("The account is not a device account to migrate")]
    NotMigratable,
}
