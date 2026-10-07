import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { usePayments } from '../payment/payments-provider'
import { rewardRecords } from './records'
import type { RewardClaims } from './seams'
import type { RewardRecord } from './state'

/** The rewards of this phone, read again whenever the screen is focused; `undefined` until the first read ends. */
export function useRewards(claims: RewardClaims | undefined) {
  const { db } = usePayments()
  const [records, setRecords] = useState<readonly RewardRecord[]>()
  const [error, setError] = useState<string>()
  const refresh = useCallback(async () => {
    if (!db) return
    try {
      setRecords(await rewardRecords(db, claims?.leaves))
      setError(undefined)
    } catch (failure) {
      setError(`Couldn’t read the rewards. ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }, [db, claims])
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh]),
  )
  return { records, error, refresh }
}
