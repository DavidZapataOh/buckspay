import { router } from 'expo-router'
import { useEffect } from 'react'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { copy } from '../../features/payment/copy'
import { ScanScreen } from '../../features/qr/scan-screen'
import { howCopy } from '../../features/transport/copy'
import { WaitingScreen } from '../../features/transport/waiting'

export default function PayScan() {
  const flow = usePayFlow()
  const { state } = flow

  useEffect(() => {
    if (state.name === 'reviewing' || state.name === 'refused') router.replace('/pay/review')
    if (state.name === 'idle') router.back()
  }, [state.name])

  // Leaving the screen with the camera still looking for a request puts the flow back at the start.
  useEffect(
    () => () => {
      if (flow.stateName() === 'scanning') flow.back()
    },
    [flow],
  )

  if (flow.how.chosen !== 'qr') {
    return (
      <WaitingScreen
        medium={flow.how.chosen}
        title={howCopy.waitingForRequest}
        notice={state.name === 'scanning' && state.wrongCode ? copy.scan.wrongCode : undefined}
        onCancel={flow.back}
        cancelLabel={copy.review.cancel}
      />
    )
  }

  return (
    <ScanScreen
      hint={copy.scan.hint}
      hintTestID="pay-scan-hint"
      progress={flow.progress}
      notice={state.name === 'scanning' && state.wrongCode ? copy.scan.wrongCode : undefined}
      onText={flow.submitText}
      onCancel={flow.back}
      cancelLabel={copy.review.cancel}
    />
  )
}
