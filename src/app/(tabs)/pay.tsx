import { router } from 'expo-router'
import { PayTab } from '../../features/pay/pay-tab'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { unfinishedView } from '../../features/pay/unfinished'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { useDeviceIdentity } from '../../features/identity/use-device-identity'
import { HowControl } from '../../features/transport/how-control'
import { pasteInto } from '../../features/qr/paste-source'

export default function Pay() {
  const { step } = useDeviceIdentity()
  const flow = usePayFlow()

  async function paste() {
    flow.scan()
    router.push('/pay/scan')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await pasteInto(flow.submitText)
  }

  return (
    <PayTab
      ready={step === 'ready'}
      allowance={flow.offline.allowance()}
      symbol={BUILD_TOKEN.symbol}
      decimals={BUILD_TOKEN.decimals}
      unfinished={flow.unfinished.map(unfinishedView)}
      credit={{ events: flow.events, selected: flow.creditEvent, onSelect: flow.setCreditEvent }}
      how={
        <HowControl
          offered={flow.how.offered}
          chosen={flow.how.chosen}
          onChoose={flow.how.choose}
          onRecheck={flow.how.refresh}
        />
      }
      onSetup={() => router.push('/onboarding')}
      onScan={() => {
        flow.scan()
        router.push('/pay/scan')
      }}
      onPaste={() => void paste()}
      onFarAway={() => router.push('/pay/far-away')}
      onAddMoney={() => router.push('/add-funds')}
      onResume={(messageId) => {
        void flow.resume(messageId).then(() => router.push('/pay/send'))
      }}
      onDiscard={(messageId) => void flow.discard(messageId)}
    />
  )
}
