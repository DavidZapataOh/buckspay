import { useEffect, useState } from 'react'
import { BUILD_GATEWAY } from '../lock/gateway'

let last: bigint | undefined

/**
 * The smallest amount the server settles now, from its quote. A phone that is offline keeps the last quote it read;
 * one that never read any shows nothing.
 */
export function useSettlementMinimum(): bigint | undefined {
  const [minimum, setMinimum] = useState(last)
  useEffect(() => {
    let current = true
    void BUILD_GATEWAY?.settlementQuote().then(
      (quote) => {
        last = quote.minAmount
        if (current) setMinimum(quote.minAmount)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])
  return minimum
}
