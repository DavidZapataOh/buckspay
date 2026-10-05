
export const BuckspayErrorCode = {
  DeviceKey: 6000,
  DeviceBinding: 6001,
  LockSeqMismatch: 6002,
  LockSeqExhausted: 6003,
  AmountZero: 6004,
  AmountOverflow: 6005,
  LockTooShort: 6006,
  LockTooLong: 6007,
  ClockOutOfRange: 6008,
  UnsupportedMintExtension: 6009,
  FeeNotAllowed: 6010,
  FeeTooHigh: 6011,
  WithdrawTooEarly: 6012,
  ReleaseTooEarly: 6013,
  CloseTooEarly: 6014,
  NotWithdrawn: 6015,
  EscrowOpen: 6016,
  SlashPending: 6017,
  InsufficientEscrow: 6018,
  RotationBinding: 6019,
  RotationNotReady: 6020,
  SameWallet: 6021,
  NotMigratable: 6022
};

export type BuckspayErrorName = keyof typeof BuckspayErrorCode;
