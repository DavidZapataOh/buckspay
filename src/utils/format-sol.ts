/** Lamports in SOL to four decimals, rounded down, or up for what something costs. */
export function formatSol(lamports: bigint, round: 'down' | 'up' = 'down'): string {
  const tenThousandths = Number(lamports) / 100_000
  return String((round === 'up' ? Math.ceil(tenThousandths) : Math.floor(tenThousandths)) / 10_000)
}
