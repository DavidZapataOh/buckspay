import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../components/app-text'
import { Button } from '../components/button'
import { Screen } from '../components/screen'
import { StatusNote } from '../components/status-note'
import { useDeviceIdentity } from '../features/identity/use-device-identity'
import { reconcileIdentity, unsettledSummary, type Unsettled } from '../features/notes/ledger'
import { BUILD_TOKEN } from '../features/pay/tokens'
import { copy, text } from '../features/payment/copy'
import { nowSeconds, usePayments } from '../features/payment/payments-provider'
import { resetDeviceIdentity } from '../keys'
import { authenticate } from '../payment/authenticate'
import { PayError } from '../payment/pay'
import { GRACE } from '../protocol'
import { formatError } from '../utils/format-error'
import { formatMoney } from '../utils/format-amount'

export default function ResetIdentity() {
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
      const confirmed = await authenticate(copy.reset.promptTitle, copy.reset.promptSubtitle, copy.reset.cancel).catch(
        (failure: unknown) => {
          if (failure instanceof PayError && failure.cause === 'NoScreenLock') return true
          throw failure
        },
      )
      if (!confirmed) return
      await resetDeviceIdentity()
      if (db) await reconcileIdentity(db, new Uint8Array(0), nowSeconds())
      await reset()
      router.replace('/')
    } catch (failure) {
      setError(`Couldn’t reset this phone. ${formatError(failure)}`)
    } finally {
      setWorking(false)
    }
  }

  const by =
    unsettled?.earliestExpiry == null ? '' : new Date((unsettled.earliestExpiry + GRACE) * 1000).toLocaleDateString()
  return (
    <Screen testID="reset-identity-screen">
      <AppText variant="headline">{copy.reset.title}</AppText>
      <View className="gap-3">
        {[
          copy.reset.newKey,
          text(copy.reset.lost, { date: by || '—' }),
          copy.reset.registration,
          copy.reset.lockStays,
        ].map((line) => (
          <AppText key={line} variant="body">
            {`• ${line}`}
          </AppText>
        ))}
      </View>
      <AppText testID="reset-count" variant="body" tone="danger">
        {unsettled && unsettled.count > 0
          ? text(copy.reset.count, {
              count: unsettled.count,
              amount: formatMoney(unsettled.total, BUILD_TOKEN.decimals),
              symbol: BUILD_TOKEN.symbol,
            })
          : copy.reset.none}
      </AppText>
      <StatusNote tone="danger" message={error} />
      <View className="gap-3">
        <Button
          testID="reset-confirm"
          variant="danger"
          label={copy.reset.confirm}
          busy={working}
          disabled={busy}
          onPress={() => void run()}
        />
        <Button
          testID="reset-cancel"
          variant="text"
          label={copy.reset.cancel}
          disabled={working}
          onPress={() => router.back()}
        />
      </View>
    </Screen>
  )
}
