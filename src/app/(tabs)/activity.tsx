import { bytesToHex } from '@noble/hashes/utils.js'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { ActivityList } from '../../features/activity/activity'
import { IncomingList } from '../../features/activity/incoming-list'
import { useIncoming } from '../../features/activity/use-incoming'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { type ActivityRow, listActivity } from '../../features/notes/activity'
import { nowSeconds, usePayments } from '../../features/payment/payments-provider'
import { ClearNotice } from '../../features/settlement/clear-notice-card'
import { PrivateSettlementCard } from '../../features/settlement/private-settlement-card'
import { SettlementLabel } from '../../features/settlement/settlement-label'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'

export default function Activity() {
  const { db } = usePayments()
  const settlement = useSettlementRunner()
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [waiting, setWaiting] = useState<string[]>([])
  const incoming = useIncoming(settlement.report)
  const onPrivateRoute = settlement.report?.private.find(
    ({ state }) => state.kind !== 'settled' && state.kind !== 'submitting',
  )
  const notice = settlement.notices.find((pending) => !waiting.includes(bytesToHex(pending.outputId)))

  const { report } = settlement
  useFocusEffect(
    useCallback(() => {
      if (!db) return
      let current = true
      void listActivity(db, 100).then((listed) => current && setRows(listed))
      return () => {
        current = false
      }
      // The list is read again when a settlement run reports.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, report]),
  )

  return (
    <ActivityList
      rows={rows}
      symbol={BUILD_TOKEN.symbol}
      decimals={BUILD_TOKEN.decimals}
      now={nowSeconds()}
      onOpen={(id) => router.push(`/activity/${id}`)}
      header={
        <>
          <IncomingList items={incoming} symbol={BUILD_TOKEN.symbol} decimals={BUILD_TOKEN.decimals} />
          {settlement.labelPending ? (
            <SettlementLabel
              count={settlement.unsettled?.count ?? 0}
              earliestExpiry={settlement.unsettled?.earliestExpiry ?? null}
              onContinue={() => void settlement.acknowledge()}
            />
          ) : onPrivateRoute ? (
            <PrivateSettlementCard
              state={onPrivateRoute.state}
              clearAllowed
              onSettleNow={() => void settlement.settleNow(onPrivateRoute.outputId)}
              onSettleInClear={() => void settlement.confirmNotice(onPrivateRoute.outputId)}
            />
          ) : notice ? (
            <ClearNotice
              holders={notice.holders}
              onSettle={() => void settlement.confirmNotice(notice.outputId)}
              onWait={() => setWaiting((ids) => [...ids, bytesToHex(notice.outputId)])}
            />
          ) : undefined}
        </>
      }
    />
  )
}
