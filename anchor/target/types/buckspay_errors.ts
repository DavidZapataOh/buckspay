
export const BuckspayErrorCode = {
  DeviceKey: 6000,
  DeviceBinding: 6001
};

export type BuckspayErrorName = keyof typeof BuckspayErrorCode;
