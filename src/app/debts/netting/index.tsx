import { router, useFocusEffect } from 'expo-router'
import { bytesToHex } from '@noble/hashes/utils.js'
import { useCallback, useState } from 'react'
import { useDebts } from '../../../features/debts/use-debts'
import { IndexScreen, type RecentSession } from '../../../features/netting/index-screen'
import { listSessions } from '../../../features/netting/session-store'
import { sessionView } from '../../../features/netting/session-view'

export default function NettingIndex() {
  const debts = useDebts()
  const [recent, setRecent] = useState<RecentSession[]>([])
  useFocusEffect(
    useCallback(() => {
      if (!debts) return
      let current = true
      void listSessions(debts.db, 10).then((rows) => {
        if (!current) return
        setRecent(
          rows.map((row) => ({
            id: bytesToHex(row.session),
            view: sessionView(
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
          })),
        )
      })
      return () => {
        current = false
      }
    }, [debts]),
  )
  return (
    <IndexScreen
      recent={recent}
      onHost={() => router.push('/debts/netting/host')}
      onJoin={() => router.push('/debts/netting/join')}
      onOpen={(id) => router.push({ pathname: '/debts/netting/[session]', params: { session: id } })}
    />
  )
}
