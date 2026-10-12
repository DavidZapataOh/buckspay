import { useTranslation } from 'react-i18next'
import { NAMESPACES, i18n } from '../../i18n'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { IconButton } from '../../components/icon-button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { useThemeColors } from '../../theme/use-theme-colors'
import { formatError } from '../../utils/format-error'
import type { Activation } from '../identity/activation'
import { ActivationForm } from '../identity/activation-form'
import type { Sponsorship } from '../identity/device-identity'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { readLockOffer } from './lock-offer'
import { addFunds } from './submit-funds'
import { useLocks } from './use-locks'
import { useOperationContext } from './use-operation-context'

/** Adds a lock to an activated phone: the same funds, terms and costs as the first one. */
export function AddFunds() {
  const { t } = useTranslation(NAMESPACES)

  const ctx = useOperationContext()
  const { wallet, deviceKey, disconnect } = useDeviceIdentity()
  const { nextLockSeq, refresh } = useLocks()
  const [primary] = useThemeColors('primary')
  const [offer, setOffer] = useState<Activation>()
  const [sponsorship, setSponsorship] = useState<Sponsorship>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!wallet || !deviceKey || nextLockSeq === undefined) return
    readLockOffer(ctx, wallet, deviceKey.publicKey, nextLockSeq).then(
      (read) => {
        setOffer(read)
        setSponsorship(ctx.gateway ? (read.quote?.available ? 'free' : 'unavailable') : undefined)
      },
      (reason: unknown) => setError(`${i18n.t('common:problem.readWallet')} ${formatError(reason)}`),
    )
  }, [ctx, wallet, deviceKey, nextLockSeq])

  return (
    <Screen testID="add-funds">
      <View className="flex-row items-center -ml-3">
        <IconButton testID="add-funds-close" icon="close" label={t('common:close')} onPress={() => router.back()} />
      </View>
      <AppText variant="headline">{t('lock:addFundsTitle')}</AppText>
      <AppText variant="body" tone="muted">
        {t('lock:addFundsBody')}
      </AppText>
      {offer && wallet && deviceKey && nextLockSeq !== undefined ? (
        <ActivationForm
          activation={offer}
          sponsorship={sponsorship}
          windows={ctx.windows}
          busy={busy}
          action={t('lock:addFundsTitle')}
          onSubmit={(input) => {
            setBusy(true)
            setError(undefined)
            void addFunds(ctx, offer, sponsorship, { wallet, key: deviceKey.publicKey, lockSeq: nextLockSeq }, input)
              .then(async (outcome) => {
                if (outcome.status === 'done') {
                  await refresh()
                  router.back()
                  return
                }
                setError(outcome.error)
                if (outcome.payInstead) setSponsorship('unavailable')
                if (outcome.reconnect) await disconnect()
              })
              .finally(() => setBusy(false))
          }}
        />
      ) : error ? null : (
        <ActivityIndicator testID="add-funds-loading" accessibilityLabel={t('lock:readingWallet')} color={primary} />
      )}
      <StatusNote testID="add-funds-error" tone="danger" message={error} />
    </Screen>
  )
}
