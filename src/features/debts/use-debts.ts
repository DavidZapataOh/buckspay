import { useMemo } from 'react'
import { deviceKeyCluster, iouDomainOf, signIou } from '../../keys'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_MINT_BYTES } from '../pay/tokens'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { useQrSession } from '../payment/use-qr-session'
import { nearbyEntry, qrEntry } from '../transport/registry'
import { useTransportChoice, useTransports } from '../transport/use-transports'
import type { Transport } from '../../transport/types'
import { summarize, type TabSummary } from './format'
import type { DebtsContext } from './flow'
import { appliedNettings, coSignedStates, listTabs, repayStatuses } from './store'
import type { NoteDb } from '../notes/db'

/** What the debt screens need from the app: the note store, this phone's key, the token and the signer. `undefined` until they are ready. */
export function useDebts(): DebtsContext | undefined {
  const { db } = usePayments()
  const { deviceKey } = useDeviceIdentity()
  const me = deviceKey?.publicKey
  return useMemo(() => {
    const cluster = deviceKeyCluster()
    if (!db || !me || !cluster) return undefined
    return {
      db,
      me,
      mint: BUILD_MINT_BYTES,
      iouDomain: iouDomainOf(cluster),
      sign: signIou,
      now: nowSeconds,
      random: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
    }
  }, [db, me])
}

/** Every tab as this phone sees it, newest activity first. */
export async function loadSummaries(db: NoteDb, me: Uint8Array): Promise<TabSummary[]> {
  const tabs = await listTabs(db)
  return Promise.all(
    tabs.map(async ({ row, pending }) =>
      summarize(
        me,
        row,
        await coSignedStates(db, row.tab),
        pending,
        await appliedNettings(db, row.tab),
        await repayStatuses(db, row.tab),
      ),
    ),
  )
}

export type DebtLink = ReturnType<typeof useDebtLink>

/** How two phones talk about a debt: the code on the screen, or Nearby. `connect` opens the chosen medium. */
export function useDebtLink(role: 'payer' | 'receiver') {
  const session = useQrSession()
  const entries = useMemo(() => [qrEntry({ transport: session.transport }), nearbyEntry], [session.transport])
  const { offered, ready, refresh } = useTransports(entries)
  const { chosen, choose } = useTransportChoice(role, ready)
  const medium = chosen ?? entries[0]
  return {
    session,
    offered,
    chosen: medium.id,
    choose,
    refresh,
    connect: (): Promise<Transport> => medium.start(role),
  }
}
