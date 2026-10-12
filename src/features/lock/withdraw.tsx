import { useTranslation } from 'react-i18next'
import { NAMESPACES, i18n } from '../../i18n'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { IconButton } from '../../components/icon-button'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { StatusNote } from '../../components/status-note'
import { useThemeColors } from '../../theme/use-theme-colors'
import { formatError } from '../../utils/format-error'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { type Funding, readFunding } from './funding'
import { lockSummary, withdrawalStatus } from './lock-copy'
import type { LockRecord } from './locks'
import { withdrawalOperation } from './operations'
import { runOperation } from './run-operation'
import { useLocks } from './use-locks'
import { useOperationContext } from './use-operation-context'

/** This phone's locks, with the date each can be withdrawn from and a button once it can. */
export function Withdraw() {
  const { t } = useTranslation(NAMESPACES)

  const ctx = useOperationContext()
  const { wallet, deviceKey, disconnect } = useDeviceIdentity()
  const { locks, error: readError, loading, refresh } = useLocks()
  const [primary] = useThemeColors('primary')
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const [funding, setFunding] = useState<Funding>()
  const [busy, setBusy] = useState<number>()
  const [error, setError] = useState<string>()
  const [payInstead, setPayInstead] = useState(false)

  useEffect(() => {
    if (!wallet) return
    readFunding(ctx.rpc, wallet, ctx.mint).then(setFunding, (reason: unknown) =>
      setError(`${i18n.t('common:problem.readWallet')} ${formatError(reason)}`),
    )
  }, [ctx, wallet])

  async function withdraw(lock: LockRecord, sponsored: boolean) {
    if (!wallet || !deviceKey || !funding) return
    setBusy(lock.lockSeq)
    setError(undefined)
    const outcome = await runOperation(
      ctx,
      withdrawalOperation({
        programAddress: ctx.programAddress,
        wallet,
        key: deviceKey.publicKey,
        rentReceiver: lock.payer,
        lockSeq: lock.lockSeq,
        mint: lock.mint,
        tokenProgram: funding.tokenProgram,
        destination: funding.account,
      }),
      sponsored,
    )
    setBusy(undefined)
    if (outcome.status === 'done') {
      setPayInstead(false)
      await refresh()
      return
    }
    setError(outcome.error)
    setPayInstead(outcome.payInstead)
    if (outcome.reconnect) await disconnect()
  }

  return (
    <Screen testID="withdraw">
      <View className="flex-row items-center -ml-3">
        <IconButton testID="withdraw-close" icon="close" label={t('common:close')} onPress={() => router.back()} />
      </View>
      <Stage hero={<Hero kind="coins" decorative size={120} />} title={t('lock:yourLocks')} />
      {loading && !locks ? (
        <ActivityIndicator testID="withdraw-loading" accessibilityLabel={t('lock:readingLocks')} color={primary} />
      ) : null}
      {locks?.length === 0 ? (
        <AppText variant="body" tone="muted" className="text-center">
          {t('lock:noLocks')}
        </AppText>
      ) : null}
      {funding
        ? locks?.map((lock) => {
            const { text, canWithdraw } = withdrawalStatus(lock, ctx.windows, now)
            return (
              <View
                key={lock.lockSeq}
                testID={`lock-${lock.lockSeq}`}
                className="gap-3 rounded-3xl border border-outline bg-surface p-5"
              >
                <View className="flex-row items-center justify-between">
                  <AppText variant="title">{t('lock:lockN', { number: lock.lockSeq + 1 })}</AppText>
                  <Info
                    title={t('lock:lockN', { number: lock.lockSeq + 1 })}
                    lines={[lockSummary(lock, funding.decimals)]}
                  />
                </View>
                <Chip kind={canWithdraw ? 'done' : 'waiting'} label={text} />
                {canWithdraw ? (
                  <Button
                    testID={`withdraw-${lock.lockSeq}`}
                    variant="filled"
                    label={payInstead ? t('lock:withdrawAndPay') : t('lock:withdraw')}
                    busy={busy === lock.lockSeq}
                    onPress={() => void withdraw(lock, !payInstead && ctx.gateway !== undefined)}
                  />
                ) : null}
              </View>
            )
          })
        : null}
      <StatusNote testID="withdraw-error" tone="danger" message={error ?? readError} />
    </Screen>
  )
}
