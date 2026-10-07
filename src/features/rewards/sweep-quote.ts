import type { Address } from '@solana/kit'

/** What the gateway wants of a sweep now: whose fee account and token account pay it, and the budget it pins. */
export type SweepQuote = {
  gateway: Address
  feeAccount: Address
  /** The least fee to a token account that exists, and to one the sweep creates; base units of the mint. */
  fee: bigint
  feeWithAccount: bigint
  computeUnitLimit: number
  computeUnitPrice: bigint
}

export function sweepQuote(gatewayUrl: string, request: typeof fetch = fetch) {
  return async (): Promise<SweepQuote> => {
    const response = await request(`${gatewayUrl}/v1/sweeps/quote`)
    if (!response.ok) throw new Error(`The gateway answered ${response.status}.`)
    const quote = (await response.json()) as Omit<SweepQuote, 'fee' | 'feeWithAccount' | 'computeUnitPrice'> & {
      fee: string
      feeWithAccount: string
      computeUnitPrice: string
    }
    return {
      ...quote,
      fee: BigInt(quote.fee),
      feeWithAccount: BigInt(quote.feeWithAccount),
      computeUnitPrice: BigInt(quote.computeUnitPrice),
    }
  }
}
