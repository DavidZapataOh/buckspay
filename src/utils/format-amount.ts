/** Base units of a token as a decimal string without trailing zeros. */
export function formatAmount(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${units / scale}.${fraction}` : String(units / scale)
}

/** The base units of a decimal amount a person typed, or `undefined` if it is not one the token can hold. */
export function parseAmount(text: string, decimals: number): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!match || (match[2]?.length ?? 0) > decimals) return undefined
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0') || 0)
}
