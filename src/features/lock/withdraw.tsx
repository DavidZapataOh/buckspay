import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { IconButton } from '../../components/icon-button'
import { Screen } from '../../components/screen'
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
      setError(`Couldn’t read your wallet. ${formatError(reason)}`),
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
        <IconButton testID="withdraw-close" icon="close" label="Close" onPress={() => router.back()} />
      </View>
      <AppText variant="headline">Your locks</AppText>
      {loading && !locks ? (
        <ActivityIndicator testID="withdraw-loading" accessibilityLabel="Reading your locks" color={primary} />
      ) : null}
      {locks?.length === 0 ? (
        <AppText variant="body" tone="muted">
          This phone has no locks.
        </AppText>
      ) : null}
      {funding
        ? locks?.map((lock) => {
            const { text, canWithdraw } = withdrawalStatus(lock, ctx.windows, now)
            return (
              <View key={lock.lockSeq} testID={`lock-${lock.lockSeq}`} className="rounded-3xl bg-surface p-5 gap-3">
                <AppText variant="title">Lock {lock.lockSeq + 1}</AppText>
                <AppText variant="body">{lockSummary(lock, funding.decimals)}</AppText>
                <AppText variant="body" tone="muted">
                  {text}
                </AppText>
                {canWithdraw ? (
                  <Button
                    testID={`withdraw-${lock.lockSeq}`}
                    variant="filled"
                    label={payInstead ? 'Withdraw and pay from my wallet' : 'Withdraw'}
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
