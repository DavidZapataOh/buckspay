import { i18n, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'
import { useEffect, useRef } from 'react'
import { usePayFlow } from '../../features/pay/use-pay-flow'

import { ScanScreen } from '../../features/qr/scan-screen'

import { WaitingScreen } from '../../features/transport/waiting'

const scanNotice = (state: { wrongCode: boolean; unreadable?: string; timedOut?: true }) =>
  state.timedOut
    ? i18n.t('payment:scan.timedOut')
    : state.unreadable
      ? i18n.t('payment:scan.unreadable', { code: state.unreadable })
      : state.wrongCode
        ? i18n.t('payment:scan.wrongCode')
        : undefined

export default function PayScan() {
  const { t } = useTranslation(NAMESPACES)

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
        title={
          state.name === 'scanning' && state.timedOut
            ? t('payment:scan.timedOutTitle')
            : t('transport:waitingForRequest')
        }
        notice={state.name === 'scanning' ? scanNotice(state) : undefined}
        onCancel={flow.back}
        cancelLabel={t('payment:review.cancel')}
      />
    )
  }

  return (
    <ScanScreen
      hint={t('payment:scan.hint')}
      hintTestID="pay-scan-hint"
      progress={flow.progress}
      notice={state.name === 'scanning' ? scanNotice(state) : undefined}
      onText={flow.submitText}
      onCancel={flow.back}
      cancelLabel={t('payment:review.cancel')}
    />
  )
}
