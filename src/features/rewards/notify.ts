import { formatMoney } from '../../utils/format-amount'
import { text } from '../payment/copy'
import { rewardsCopy } from './copy'

export const REWARDS_URL = 'buckspay://activity/rewards'

export type Notice = { title: string; body: string; url: string }

/** Remembers which words were already announced, across restarts. */
export type Seen = { has: (id: string) => Promise<boolean>; add: (id: string) => Promise<void> }

export type NotifyDeps = {
  schedule: (notice: Notice) => Promise<void>
  seen: Seen
}

/**
 * Announces a newly held word once. The amount is left out of the notification unless the person turned amounts on,
 * because a lock screen can be read by others. A failed scheduling is thrown and the word stays unannounced.
 */
export async function notifyHeldWord(
  word: { id: string; value: bigint },
  options: { showAmounts: boolean; symbol: string; decimals: number },
  { schedule, seen }: NotifyDeps,
): Promise<void> {
  if (await seen.has(word.id)) return
  const body = options.showAmounts
    ? text(rewardsCopy.notification.bodyAmount, {
        amount: formatMoney(word.value, options.decimals),
        symbol: options.symbol,
      })
    : rewardsCopy.notification.body
  await schedule({ title: rewardsCopy.notification.title, body, url: REWARDS_URL })
  await seen.add(word.id)
}
