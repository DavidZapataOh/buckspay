import { router } from 'expo-router'
import { FarAwayPay } from '../../features/remote/far-away-pay'
import { useFarAway } from '../../features/remote/use-far-away'
import { useTipTerms } from '../../features/rewards/seams'
import { useTipping } from '../../features/rewards/use-tipping'
import { nowSeconds } from '../../features/payment/payments-provider'

export default function PayFarAway() {
  const far = useFarAway()
  const { tip } = useTipping(useTipTerms())
  return (
    <FarAwayPay
      contacts={far.contacts}
      now={nowSeconds()}
      online={far.online}
      pendingTo={far.pendingTo}
      deadlineFor={far.deadlineFor}
      busy={far.busy}
      tip={tip}
      error={far.error}
      onAddLink={() => router.push('/pay/far-away-link')}
      onConfirm={(contact, amount) => {
        void far.pay(contact, amount).then((outcome) => outcome && router.replace('/(tabs)/activity'))
      }}
    />
  )
}
