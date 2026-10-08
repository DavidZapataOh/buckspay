import { router, useFocusEffect } from 'expo-router'
import { bytesToHex } from '@noble/hashes/utils.js'
import { useCallback, useState } from 'react'
import { DebtsScreen } from '../../features/debts/debts-screen'
import type { TabSummary } from '../../features/debts/format'
import { loadSummaries, useDebts } from '../../features/debts/use-debts'
import { BUILD_TOKEN } from '../../features/pay/tokens'

export default function DebtsIndex() {
  const debts = useDebts()
  const [tabs, setTabs] = useState<TabSummary[]>([])
  useFocusEffect(
    useCallback(() => {
      if (!debts) return
      let current = true
      void loadSummaries(debts.db, debts.me).then((loaded) => current && setTabs(loaded))
      return () => {
        current = false
      }
    }, [debts]),
  )
  return (
    <DebtsScreen
      tabs={tabs}
      symbol={BUILD_TOKEN.symbol}
      decimals={BUILD_TOKEN.decimals}
      onOpen={(tab) => router.push({ pathname: '/debts/[tab]', params: { tab: bytesToHex(tab) } })}
      onNew={() => router.push('/debts/new')}
    />
  )
}
