import { hexToBytes } from '@noble/hashes/utils.js'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { summarize, type TabSummary } from '../../features/debts/format'
import {
  appliedNettings,
  coSignedStates,
  pendingProposal,
  recordedNettings,
  repayStatuses,
  statesOf,
  tabById,
} from '../../features/debts/store'
import type { StateRow } from '../../features/debts/store'
import { TabScreen } from '../../features/debts/tab-screen'
import { useDebts } from '../../features/debts/use-debts'
import { BUILD_TOKEN } from '../../features/pay/tokens'

type Loaded = { summary: TabSummary; history: StateRow[]; nettings: { cancel: bigint; recordedAt: number }[] }

export default function Tab() {
  const debts = useDebts()
  const { tab } = useLocalSearchParams<{ tab: string }>()
  const [loaded, setLoaded] = useState<Loaded>()
  useFocusEffect(
    useCallback(() => {
      if (!debts) return
      let current = true
      void (async () => {
        const id = hexToBytes(tab)
        const row = await tabById(debts.db, id)
        if (!row) return
        const [states, applied, repays, pending] = [
          await coSignedStates(debts.db, id),
          await appliedNettings(debts.db, id),
          await repayStatuses(debts.db, id),
          await pendingProposal(debts.db, id),
        ]
        const summary = summarize(debts.me, row, states, pending, applied, repays)
        if (current)
          setLoaded({ summary, history: await statesOf(debts.db, id), nettings: await recordedNettings(debts.db, id) })
      })()
      return () => {
        current = false
      }
    }, [debts, tab]),
  )
  if (!debts || !loaded) return null
  const go = (action: string) => router.push({ pathname: '/debts/new', params: { tab, action } })
  return (
    <TabScreen
      {...loaded}
      me={debts.me}
      symbol={BUILD_TOKEN.symbol}
      decimals={BUILD_TOKEN.decimals}
      busy={false}
      onChange={go}
      onResend={() => go('resend')}
    />
  )
}
