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
    #[msg("The transaction does not carry the secp256r1 verification of exactly this chain")]
    ChainVerification,
    #[msg("The messages are not a valid chain")]
    ChainInvalid,
    #[msg("The issue does not match the lock it names")]
    WrongLock,
    /// More spends than a note can have, or more messages to verify than one precompile
    /// instruction carries.
    #[msg("Too many spends for one instruction")]
    TooManySpends,
    #[msg("The settlement window of the output has closed")]
    SettlementClosed,
    #[msg("The lock has ended")]
    LockEnded,
    #[msg("The destination does not belong to the account the note pays")]
    WrongPayee,
    #[msg("The output was already consumed by another message")]
    ConflictingSpend,
    #[msg("This message was already paid")]
    AlreadySettled,
    #[msg("The output cannot be reclaimed yet")]
    ReclaimTooEarly,
    #[msg("Wrong number or address of record accounts")]
    RecordAccounts,
    #[msg("The record cannot be closed yet")]
    RecordNotClosable,
    #[msg("The reclaim window of the output has closed")]
    ReclaimClosed,
    #[msg("The reclaim signature is past its deadline")]
    ReclaimExpired,
    #[msg("An output of the chain has no record address or no claim address")]
    UnrecordableOutput,
    #[msg("The two messages do not conflict")]
    NotConflicting,
    #[msg("The proof does not match its body, signer or lock")]
    ConflictProof,
    #[msg("The lock has no free bond to slash")]
    NoBond,
    #[msg("The claim deadline of the output has passed")]
    ClaimTooLate,
    #[msg("The loss cannot be claimed from this lock")]
    NotClaimable,
    #[msg("The output has no record")]
    NoRecord,
    #[msg("The output was already claimed")]
    AlreadyClaimed,
    #[msg("The output is larger than the lock's bond covers")]
    OverCoverage,
    #[msg("The stake is below the minimum")]
    StakeTooLow,
    #[msg("The key is not a canonical point of the prime-order subgroup")]
    AttesterKey,
    #[msg("The attester's status does not allow this")]
    AttesterStatus,
    #[msg("The attester cannot withdraw its stake yet")]
    ExitNotReady,
    #[msg("The key was rotated too recently to rotate again")]
    RotationCooldown,
    #[msg("The instruction before this one is not the Ed25519 verification of this ticket")]
    TicketBinding,
    #[msg("The chain does not contradict the ticket")]
    TicketNotProvablyFalse,
    #[msg("The attester was already slashed")]
    AlreadySlashed,
    #[msg("The key that signed the ticket is not one the attester answers for")]
    UnknownSigner,
    #[msg("A claim on a spend that named no lock needs the device of the lock owner")]
    DeviceRequired,
    #[msg("The verifying key is not the one this program accepts")]
    StaleVerifyingKey,
    #[msg("The batch of proofs does not verify")]
    ProofRejected,
    #[msg("A value of the proof's public inputs is not a canonical field element")]
    NonCanonicalPublic,
    #[msg("The proof buffer does not hold every message yet")]
    BufferIncomplete,
    #[msg("The proof buffer cannot be closed yet")]
    BufferNotStale,
    #[msg("The proof buffer has a length that holds no whole number of messages")]
    BufferLength,
    #[msg("The write does not fit the buffer or leaves a gap")]
    BufferWrite,
    #[msg("Private settlement is paused")]
    ZkPaused,
    #[msg("The mint's private settlement cap for this window is exhausted")]
    ZkCapExceeded,
    #[msg("The payment does not exceed the fee for the records it creates")]
    BelowRecordFee,
    #[msg("The mint is not enabled for private settlement")]
    MintNotEnabled,
    #[msg("The signer is not allowed to change the private settlement configuration")]
    NotZkAdmin,
    #[msg("A lock's cap may not exceed a tenth of the mint's cap")]
    LockCapTooHigh,
    #[msg("The keys of a throwaway ceremony cannot be used on mainnet")]
    TestKeysOnMainnet,
    #[msg("The fee account is not the one configured for the mint")]
    WrongFeeAccount,
    #[msg("The word does not verify against the root of its channel")]
    WordRejected,
    #[msg("The word was already settled")]
    WordAlreadySettled,
    #[msg("The settlement window of the channel has closed")]
    ChannelWindowClosed,
    #[msg("The commitment does not price its words as the mint does")]
    WordValueMismatch,
    #[msg("The inners are not one per leaf of the words' canonical decomposition")]
    InnersDoNotMatchWords,
    #[msg("An inner is not a canonical field element")]
    NonCanonicalInner,
    #[msg("Too many channels in one transaction")]
    TooManyChannels,
    #[msg("The channel cannot be closed yet")]
    ChannelStillOpen,
    #[msg("The commitment is above a quarter of the lock's bond")]
    ChannelAboveBondQuarter,
    #[msg("The commitment is malformed or its depth is out of range")]
    CommitmentInvalid,
    #[msg("The signer is not allowed to change the reward configuration")]
    NotRewardAdmin,
    #[msg("The ledger is not a reward pool")]
    NotRewardPool,
    #[msg("The fees do not fit the value of a word")]
    FeeAboveValue,
    #[msg("The reward tree of this epoch cannot take another batch")]
    TreeFull,
    #[msg("The reward tree of this epoch still has room")]
    TreeNotFull,
    #[msg("Poseidon failed on canonical inputs")]
    HashFailed,
    #[msg("Rewards are paused")]
    RewardsPaused,
    #[msg("The root is not one the tree of this epoch holds")]
    UnknownRoot,
    #[msg("A nullifier was already claimed")]
    NullifierReused,
    #[msg("A nullifier hash is not a canonical field element")]
    NonCanonicalNullifier,
    #[msg("The claim proof does not verify")]
    ClaimRejected,
    #[msg("The claim fee is above the maximum the proof allows")]
    FeeAboveMax,
    #[msg("The claims in the window are above the cap")]
    ClaimCapExceeded,
    #[msg("The exponent is not one a word batch can have")]
    BadDenomination,
    #[msg("The claim key is not the current one, nor the previous one inside its window")]
    StaleClaimKey,
    #[msg("The number of claims is zero, above the limit, or not the number of accounts")]
    ClaimCount,
    #[msg("The account is not the reward tree of the claim's epoch")]
    WrongRewardTree,
    #[msg("The account is not the nullifier account of the claim")]
    WrongNullifierAccount,
}
