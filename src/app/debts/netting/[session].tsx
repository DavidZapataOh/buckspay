import { hexToBytes } from '@noble/hashes/utils.js'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { useDebts } from '../../../features/debts/use-debts'
import { BUILD_TOKEN } from '../../../features/pay/tokens'
import { loadSession } from '../../../features/netting/session-store'
import { SessionScreen } from '../../../features/netting/session-screen'
import { type SessionView, sessionView } from '../../../features/netting/session-view'

export default function NettingSession() {
  const debts = useDebts()
  const { session } = useLocalSearchParams<{ session: string }>()
  const [view, setView] = useState<SessionView>()
  useFocusEffect(
    useCallback(() => {
      if (!debts) return
      let current = true
      void loadSession(debts.db, hexToBytes(session)).then((row) => {
        if (!current || !row) return
        setView(
          sessionView(
            {
              status: row.status,
              role: row.role,
              expires: row.expires,
              proof: null,
              nothing: false,
              recordPending: false,
              remainder: [],
            },
            debts.now(),
          ),
        )
      })
      return () => {
        current = false
      }
    }, [debts, session]),
  )
  return view ? <SessionScreen view={view} symbol={BUILD_TOKEN.symbol} decimals={BUILD_TOKEN.decimals} /> : null
}
