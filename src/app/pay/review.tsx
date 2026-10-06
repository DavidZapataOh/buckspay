import { router } from 'expo-router'
import { useEffect } from 'react'
import { Screen } from '../../components/screen'
import { PayRefused } from '../../features/pay/refusal'
import { PayReview } from '../../features/pay/review'
import { PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { formatMoney } from '../../utils/format-amount'

const money = (units: bigint) => `${formatMoney(units, BUILD_TOKEN.decimals)} ${BUILD_TOKEN.symbol}`

export default function PayReviewScreen() {
  const flow = usePayFlow()
  const { state } = flow

  useEffect(() => {
    if (state.name === 'presenting' || state.name === 'failed') router.replace('/pay/send')
  }, [state.name])

  if (state.name === 'reviewing' || state.name === 'confirming') {
    return (
      <Screen testID="pay-review-screen">
        <PayReview
          plan={state.plan}
          busy={state.name === 'confirming'}
          onConfirm={() => void flow.confirm()}
          onCancel={() => {
            flow.back()
            router.back()
          }}
        />
      </Screen>
    )
  }
  if (state.name === 'refused') {
    return (
      <Screen testID="pay-refused-screen">
        <PayRefused
          reason={state.reason}
          values={{
            max: money(PAY_LIMITS.maxPayment),
            amount: money(state.request.amount),
            allowance: money(flow.offline.allowance()),
          }}
          onAction={(action) => {
            flow.back()
            if (action === 'Add money') router.replace('/add-funds')
            else if (action === 'Activity') router.replace('/activity')
            else router.back()
          }}
        />
      </Screen>
    )
  }
  return null
}
