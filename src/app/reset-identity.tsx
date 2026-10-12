import { formatDate, formatMoney } from '../i18n/format'
import { currentLanguage, NAMESPACES } from '../i18n'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Button } from '../components/button'
import { Chip } from '../components/chip'
import { Hero } from '../components/hero'
import { Info } from '../components/info'
import { Screen } from '../components/screen'
import { Stage } from '../components/stage'
import { StatusNote } from '../components/status-note'
import { useDeviceIdentity } from '../features/identity/use-device-identity'
import { reconcileIdentity, unsettledSummary, type Unsettled } from '../features/notes/ledger'
import { BUILD_TOKEN } from '../features/pay/tokens'
import { nowSeconds, usePayments } from '../features/payment/payments-provider'
import { resetDeviceIdentity } from '../keys'
import { authenticate } from '../payment/authenticate'
import { PayError } from '../payment/pay'
import { GRACE } from '../protocol'
import { formatError } from '../utils/format-error'

export default function ResetIdentity() {
  const { t } = useTranslation(NAMESPACES)

  const { db } = usePayments()
  const { reset, busy } = useDeviceIdentity()
  const [unsettled, setUnsettled] = useState<Unsettled>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (db) void unsettledSummary(db).then(setUnsettled)
  }, [db])

  async function run() {
    setError(undefined)
    setWorking(true)
    try {
      // A phone with no screen lock has nothing to ask: the person has just read what is lost.
      const confirmed = await authenticate(
        t('payment:reset.promptTitle'),
        t('payment:reset.promptSubtitle'),
        t('payment:reset.cancel'),
      ).catch((failure: unknown) => {
        if (failure instanceof PayError && failure.cause === 'NoScreenLock') return true
        throw failure
      })
      if (!confirmed) return
      await resetDeviceIdentity()
      if (db) await reconcileIdentity(db, new Uint8Array(0), nowSeconds())
      await reset()
      router.replace('/')
    } catch (failure) {
      setError(`${t('payment:reset.failed')} ${formatError(failure)}`)
    } finally {
      setWorking(false)
    }
  }

  const by = unsettled?.earliestExpiry == null ? '' : formatDate(unsettled.earliestExpiry + GRACE, currentLanguage())
  const count =
    unsettled && unsettled.count > 0
      ? t('payment:reset.count', {
          count: unsettled.count,
          amount: formatMoney(unsettled.total, BUILD_TOKEN.decimals, currentLanguage()),
          symbol: BUILD_TOKEN.symbol,
        })
      : t('payment:reset.none')
  return (
    <Screen
      testID="reset-identity-screen"
      footer={
        <View className="gap-3">
          <Button
            testID="reset-confirm"
            variant="danger"
            label={t('payment:reset.confirm')}
            busy={working}
            disabled={busy}
            onPress={() => void run()}
          />
          <Button
            testID="reset-cancel"
            variant="text"
            label={t('payment:reset.cancel')}
            disabled={working}
            onPress={() => router.back()}
          />
        </View>
      }
    >
      <Stage hero={<Hero kind="problem" decorative />} title={t('payment:reset.title')}>
        <View testID="reset-count" className="flex-row items-center gap-1">
          <Chip center kind="problem" label={count} />
          <Info
            title={t('payment:reset.title')}
            lines={[
              t('payment:reset.newKey'),
              t('payment:reset.lost', { date: by || '—' }),
              t('payment:reset.registration'),
              t('payment:reset.lockStays'),
            ]}
          />
        </View>
      </Stage>
      <StatusNote tone="danger" message={error} />
    </Screen>
  )
}
