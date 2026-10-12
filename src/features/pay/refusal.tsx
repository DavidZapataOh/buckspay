import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { PlanRefusal } from '../../payment/preflight'

export type RefusalAction = 'add-money' | 'activity' | 'back'

/** What the button of each refusal does; the words on it come from the catalog and change with the language. */
const ACTIONS: Record<PlanRefusal, RefusalAction> = {
  Malformed: 'back',
  UnknownMint: 'back',
  AboveYourLimit: 'back',
  SelfPayment: 'back',
  ClockOrExpired: 'back',
  AlreadyPaid: 'activity',
  NoLock: 'add-money',
  AttesterNotTrusted: 'back',
  BondTooSmall: 'add-money',
  AllowanceTooLow: 'add-money',
  LockTooShort: 'add-money',
  TicketStale: 'back',
}

export const refusalAction = (reason: PlanRefusal): RefusalAction => ACTIONS[reason]

/** What the payer is told when a request cannot be paid, and the one thing to do about it. */
export function PayRefused({
  reason,
  values,
  onAction,
}: {
  reason: PlanRefusal
  values: { max: string; amount: string; allowance: string }
  onAction: (action: RefusalAction) => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const sentence = t(`payment:refusal.${reason}.text`, values)
  const action = t(`payment:refusal.${reason}.action`)
  return (
    <View className="gap-6">
      <AppText testID="pay-refused" variant="body" accessibilityLiveRegion="polite">
        {sentence}
      </AppText>
      <Button
        testID="pay-refused-action"
        variant="filled"
        label={action}
        onPress={() => onAction(refusalAction(reason))}
      />
    </View>
  )
}
