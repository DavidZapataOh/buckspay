import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { StatusNote } from '../../components/status-note'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { rotationNotice } from './lock-copy'
import { rotationCancelOperation } from './operations'
import { runOperation } from './run-operation'
import { useOperationContext } from './use-operation-context'
import { useRotationWatch } from './use-rotation-watch'

/**
 * Warns of a wallet rotation nobody on this phone asked for, with a one-tap cancel that Buckspay
 * pays for, or the wallet when Buckspay cannot.
 */
export function RotationAlert() {
  const { t } = useTranslation(NAMESPACES)

  const ctx = useOperationContext()
  const { wallet, deviceKey } = useDeviceIdentity()
  const { alert, refresh } = useRotationWatch()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [payInstead, setPayInstead] = useState(false)
  if (!alert || !wallet || !deviceKey) return null

  async function cancel(sponsored: boolean) {
    if (!alert || !wallet || !deviceKey) return
    setBusy(true)
    setError(undefined)
    const outcome = await runOperation(
      ctx,
      rotationCancelOperation({
        programAddress: ctx.programAddress,
        wallet,
        key: deviceKey.publicKey,
        rentReceiver: alert.payer,
      }),
      sponsored,
    )
    setBusy(false)
    if (outcome.status === 'done') {
      setPayInstead(false)
      refresh()
      return
    }
    setError(outcome.error)
    setPayInstead(outcome.payInstead)
  }

  return (
    <View testID="rotation-alert" className="gap-3 rounded-3xl border border-danger bg-danger-container p-5">
      <View className="flex-row items-center justify-between gap-2">
        <Chip kind="problem" label={t('lock:rotationTitle')} />
        <Info title={t('lock:rotationTitle')} lines={[rotationNotice(alert.newWallet, alert.effectiveAt)]} />
      </View>
      <AppText variant="body">{t('lock:rotationAsk')}</AppText>
      <StatusNote testID="rotation-error" tone="danger" message={error} />
      <Button
        testID="rotation-cancel"
        variant="filled"
        label={payInstead ? t('lock:cancelAndPay') : t('lock:cancelChange')}
        busy={busy}
        onPress={() => void cancel(!payInstead && ctx.gateway !== undefined)}
      />
    </View>
  )
}
