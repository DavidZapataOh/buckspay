import { router } from 'expo-router'
import { useEffect, useRef } from 'react'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { copy, text } from '../../features/payment/copy'
import { ScanScreen } from '../../features/qr/scan-screen'
import { howCopy } from '../../features/transport/copy'
import { WaitingScreen } from '../../features/transport/waiting'

const scanNotice = (state: { wrongCode: boolean; unreadable?: string; timedOut?: true }) =>
  state.timedOut
    ? copy.scan.timedOut
    : state.unreadable
      ? text(copy.scan.unreadable, { code: state.unreadable })
      : state.wrongCode
        ? copy.scan.wrongCode
        : undefined

export default function PayScan() {
  const flow = usePayFlow()
  const { state } = flow

  useEffect(() => {
    if (state.name === 'reviewing' || state.name === 'refused') router.replace('/pay/review')
    if (state.name === 'idle') router.back()
  }, [state.name])

  // Leaving the screen with the camera still looking for a request puts the flow back at the start.
  const latest = useRef(flow)
  useEffect(() => {
    latest.current = flow
  })
  useEffect(
    () => () => {
      if (latest.current.stateName() === 'scanning') latest.current.back()
    },
    [],
  )

  if (flow.how.chosen !== 'qr') {
    return (
      <WaitingScreen
        medium={flow.how.chosen}
        title={state.name === 'scanning' && state.timedOut ? copy.scan.timedOutTitle : howCopy.waitingForRequest}
        notice={state.name === 'scanning' ? scanNotice(state) : undefined}
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
      notice={state.name === 'scanning' ? scanNotice(state) : undefined}
      onText={flow.submitText}
      onCancel={flow.back}
      cancelLabel={copy.review.cancel}
    />
  )
}
