import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { copy } from '../../features/payment/copy'
import { bytesToHex } from '@noble/hashes/utils.js'
import { router } from 'expo-router'
import { useState } from 'react'
import { AcceptScreen } from '../../features/debts/accept-screen'
import { failureText } from '../../features/debts/errors'
import type { OfferView } from '../../features/debts/exchange'
import { ExchangeView } from '../../features/debts/exchange-view'
import { answerTabOffer } from '../../features/debts/flow'
import { friendCode, peerLabel } from '../../features/debts/format'
import { useDebtLink, useDebts } from '../../features/debts/use-debts'
import { BUILD_TOKEN } from '../../features/pay/tokens'

type Asked = { view: OfferView; answer: (signs: boolean) => void }

/** Ready to receive a debt: shows this phone's friend code, then asks the person to sign what arrives. */
export default function Accept() {
  const debts = useDebts()
  const link = useDebtLink('receiver')
  const [asked, setAsked] = useState<Asked>()
  const [failed, setFailed] = useState<string>()
  if (!debts) return null
  if (failed) {
    return <Failed message={failed} />
  }
  const peer = asked
    ? peerLabel(
        asked.view.state.debtor.every((b, i) => b === debts.me[i])
          ? asked.view.state.creditor
          : asked.view.state.debtor,
      )
    : ''
  return (
    <ExchangeView
      link={link}
      title="Ready to receive a debt"
      idleCode={friendCode(debts.me)}
      run={(transport, signal) =>
        answerTabOffer(
          debts,
          transport,
          (view) => new Promise<boolean>((resolve) => setAsked({ view, answer: resolve })),
          signal,
        )
      }
      onDone={(signed) => {
        if (signed) router.replace({ pathname: '/debts/[tab]', params: { tab: bytesToHex(signed.iou.tab) } })
        else router.back()
      }}
      onFail={(error) => setFailed(failureText(error, peer))}
      onCancel={() => router.back()}
      overlay={
        asked ? (
          <AcceptScreen
            view={asked.view}
            me={debts.me}
            peerLabel={peer}
            symbol={BUILD_TOKEN.symbol}
            decimals={BUILD_TOKEN.decimals}
            viaCode={link.chosen === 'qr'}
            busy={false}
            onSign={() => {
              asked.answer(true)
              setAsked(undefined)
            }}
            onDecline={() => {
              asked.answer(false)
              setAsked(undefined)
            }}
          />
        ) : undefined
      }
    />
  )
}

function Failed({ message }: { message: string }) {
  return (
    <Screen testID="debts-failed">
      <AppText variant="headline" tone="danger" accessibilityLiveRegion="polite">
        {message}
      </AppText>
      <Button variant="filled" label={copy.send.done} onPress={() => router.back()} />
    </Screen>
  )
}
