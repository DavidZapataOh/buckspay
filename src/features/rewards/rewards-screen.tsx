import { formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'

import { ClaimConfirm, MoveConfirm } from './claim-flow'

import { rewardRows, type RewardRecord, type RewardRow, totals } from './state'

type Step = 'list' | 'claim' | 'move'

const reason = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

/**
 * The relayer's rewards: what is waiting, ready, claiming, claimed or not paid, and the claim and move steps.
 * `rows` is undefined while they are being read, so a first launch never shows an empty list that is not true.
 * Without `onClaim` or `onMove` that step is not offered.
 */
export function RewardsScreen({
  rows: records,
  symbol,
  decimals,
  onClaim,
  onMove,
  onOpenSignature,
  error,
}: {
  rows: readonly RewardRecord[] | undefined
  symbol: string
  decimals: number
  onClaim?: (options: { immediate: boolean }) => Promise<void>
  onMove?: () => Promise<void>
  onOpenSignature?: (signature: string) => void
  /** Why the rewards could not be read. */
  error?: string
}) {
  const { t } = useTranslation(NAMESPACES)

  const [step, setStep] = useState<Step>('list')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string }>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const rows = records ? rewardRows(records) : undefined
  const sum = rows ? totals(rows) : undefined
  const money = (amount: bigint) => ({ amount: formatMoney(amount, decimals, currentLanguage()), symbol })

  async function run(action: () => Promise<void>, done: string, failed: (reason: string) => string) {
    setBusy(true)
    setMessage(undefined)
    try {
      await action()
      if (!mounted.current) return
      setStep('list')
      setMessage({ tone: 'success', text: done })
    } catch (failure) {
      if (mounted.current) setMessage({ tone: 'danger', text: failed(reason(failure)) })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Screen testID="rewards">
      <AppText variant="headline">{t('rewards:title')}</AppText>
      <AppText variant="label" tone="muted">
        {t('rewards:trust')}
      </AppText>
      <StatusNote tone={error ? 'danger' : (message?.tone ?? 'default')} message={error ?? message?.text} />
      {rows === undefined && !error ? <AppText variant="body">{t('rewards:loading')}</AppText> : null}
      {rows?.length === 0 ? (
        <AppText variant="body" tone="muted">
          {t('rewards:empty')}
        </AppText>
      ) : null}
      {step === 'list' && sum ? (
        <View className="gap-2">
          {onClaim && sum.ready > 0n ? (
            <Button variant="filled" label={t('rewards:claim')} onPress={() => setStep('claim')} />
          ) : null}
          {onMove && sum.claimed > 0n ? (
            <Button variant="tonal" label={t('rewards:move')} onPress={() => setStep('move')} />
          ) : null}
        </View>
      ) : null}
      {step === 'claim' && onClaim ? (
        <ClaimConfirm
          busy={busy}
          onClaim={(immediate) =>
            void run(
              () => onClaim({ immediate }),
              t('rewards:claimScheduled'),
              (why) => t('rewards:claimFailed', { reason: why }),
            )
          }
          onCancel={() => setStep('list')}
        />
      ) : null}
      {step === 'move' && onMove ? (
        <MoveConfirm
          busy={busy}
          onMove={() => void run(onMove, t('rewards:moved'), (why) => t('rewards:moveFailed', { reason: why }))}
          onCancel={() => setStep('list')}
        />
      ) : null}
      {rows?.map((row, index) => (
        <RewardLine key={index} row={row} money={money} onOpenSignature={onOpenSignature} />
      ))}
    </Screen>
  )
}

function RewardLine({
  row,
  money,
  onOpenSignature,
}: {
  row: RewardRow
  money: (amount: bigint) => { amount: string; symbol: string }
  onOpenSignature?: (signature: string) => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const line =
    row.state === 'claiming'
      ? t('rewards:claiming')
      : row.state === 'not_paid'
        ? t(`rewards:notPaid.${row.reason ?? 'unknown'}`)
        : t(`rewards:${row.state}`, money(row.amount))
  return (
    <View className="min-h-14 justify-center py-2">
      <AppText variant="body" tone={row.state === 'not_paid' ? 'danger' : 'default'}>
        {line}
      </AppText>
      {row.signature && onOpenSignature ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('rewards:explorer')}
          onPress={() => onOpenSignature(row.signature ?? '')}
          className="min-h-12 justify-center"
        >
          <AppText variant="label" tone="muted">
            {t('rewards:explorer')}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  )
}
