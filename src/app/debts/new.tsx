import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { debtsCopy } from '../../features/debts/copy'
import { failureText } from '../../features/debts/errors'
import { ExchangeView } from '../../features/debts/exchange-view'
import { proposeTabChange, resendPending } from '../../features/debts/flow'
import { parseFriendCode, peerLabel } from '../../features/debts/format'
import { NewDebtScreen } from '../../features/debts/new-debt-screen'
import { pendingProposal, tabById, takeNextSeq } from '../../features/debts/store'
import type { TabIntent } from '../../features/debts/tab'
import { useDebtLink, useDebts } from '../../features/debts/use-debts'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { copy } from '../../features/payment/copy'
import { ScanScreen } from '../../features/qr/scan-screen'

type Intent = Pick<TabIntent, 'kind' | 'amount' | 'due' | 'memo'>
type Action = 'lent' | 'borrowed' | 'repaid' | 'clear' | 'resend'
const immediate = (peer: Uint8Array, action?: Action): Stage | undefined =>
  action === 'resend'
    ? { name: 'offer', peer, intent: 'resend' }
    : action === 'clear'
      ? { name: 'offer', peer, intent: { kind: 'clear', amount: 0n, due: 0, memo: null } }
      : undefined

type Stage =
  | { name: 'form'; peer: Uint8Array }
  | { name: 'offer'; peer: Uint8Array; intent: Intent | 'resend' }
  | { name: 'failed'; message: string }

/** A new debt, a change to a known one (`tab`, `action`), or the pending offer sent again (`action=resend`). */
export default function NewDebt() {
  const debts = useDebts()
  const link = useDebtLink('payer')
  const params = useLocalSearchParams<{ tab?: string; action?: Action }>()
  const [loaded, setLoaded] = useState<{ tab: Uint8Array; peer: Uint8Array } | null>()
  const [chosen, setStage] = useState<Stage>()
  const [scanned, setScanned] = useState<Uint8Array>()

  useEffect(() => {
    if (!debts || !params.tab) return
    void tabById(debts.db, hexToBytes(params.tab)).then((row) => setLoaded(row && { tab: row.tab, peer: row.peer }))
  }, [debts, params.tab])

  const tab = params.tab ? loaded : null
  const stage = chosen ?? (tab ? immediate(tab.peer, params.action) : undefined)

  if (!debts || tab === undefined) return null
  const peer = tab?.peer ?? scanned
  if (!peer) {
    return (
      <ScanScreen
        hint={copy.scan.hint}
        hintTestID="debts-friend-hint"
        onText={(text) => setScanned(parseFriendCode(text))}
        onCancel={() => router.back()}
        cancelLabel={copy.review.cancel}
      />
    )
  }
  if (stage?.name === 'failed') {
    return (
      <Screen testID="debts-failed">
        <AppText variant="headline" tone="danger" accessibilityLiveRegion="polite">
          {stage.message}
        </AppText>
        <Button variant="filled" label={copy.send.done} onPress={() => router.back()} />
      </Screen>
    )
  }
  if (stage?.name !== 'offer') {
    return (
      <NewDebtScreen
        symbol={BUILD_TOKEN.symbol}
        decimals={BUILD_TOKEN.decimals}
        peerLabel={peerLabel(peer)}
        viaCode={link.chosen === 'qr'}
        busy={false}
        error={null}
        onSubmit={(intent) =>
          setStage({ name: 'offer', peer, intent: params.action === 'repaid' ? { ...intent, kind: 'repaid' } : intent })
        }
      />
    )
  }
  const { intent } = stage
  return (
    <ExchangeView
      link={link}
      title={debtsCopy.send}
      run={async (transport, signal) => {
        if (tab && intent === 'resend') return resendPending(debts, transport, tab.tab, signal)
        // Making a new change while an offer waits leaves that offer behind: one seq is burnt, never the tab.
        if (tab && (await pendingProposal(debts.db, tab.tab))) await takeNextSeq(debts.db, tab.tab)
        if (intent === 'resend') throw new Error('There is no offer to send again')
        return proposeTabChange(debts, transport, peer, { ...intent, due: intent.due }, signal)
      }}
      onDone={(signed) => router.replace({ pathname: '/debts/[tab]', params: { tab: bytesToHex(signed.iou.tab) } })}
      onFail={(error) => setStage({ name: 'failed', message: failureText(error, peerLabel(peer)) })}
      onCancel={() => router.back()}
    />
  )
}
