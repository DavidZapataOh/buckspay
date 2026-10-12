import { formatDateTime, formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { StatusNote } from '../../components/status-note'
import type { Plan } from '../../payment/preflight'
import type { RespendPlan } from '../../payment/respend'

import { useTouchGuard } from './use-touch-guard'

/**
 * The confirmation screen's body, and the only way to a signature. It reads the plan alone, which was
 * made from the issue that will be signed: nothing on it can differ from what is signed.
 */
export function PayReview({
  plan,
  event,
  nearbyCheck = false,
}: {
  plan: Plan | RespendPlan
  /** The event whose credit this is, when the payment sells event credit. */
  event?: string
  /** The receiver will ask for a nearby check after this payment. */
  nearbyCheck?: boolean
}) {
  const { t } = useTranslation(NAMESPACES)

  const { review } = plan
  const passedOn = 'spend' in plan
  const hops = 'issue' in plan ? plan.issue.caveats.hopsLeft : plan.review.hopsAfter
  const [open, setOpen] = useState(false)
  useTouchGuard(true)

  const money = (units: bigint) => formatMoney(units, review.decimals, currentLanguage())
  const consequences = passedOn
    ? [t('payment:review.finalForThem'), t('payment:review.ifRefusedReceived')]
    : [t('payment:review.finalForThem'), t('payment:review.nothingLeaves'), t('payment:review.ifRefused')]

  return (
    <View className="gap-4">
      <View className="items-center gap-1 pt-2">
        <AppText variant="label" tone="muted" accessibilityRole="header">
          {t('common:tabs.pay')}
        </AppText>
        <Amount testID="pay-review" value={money(review.amount)} symbol={review.symbol} />
      </View>
      {nearbyCheck ? (
        <View testID="pay-nearby-check" className="flex-row items-center justify-center gap-1">
          <Chip kind="info" icon="hearing" label={t('witness:reviewAsks')} />
          <Info title={t('witness:reviewAsks')} lines={[t('witness:reviewAsksMore')]} />
        </View>
      ) : null}

      <View testID="pay-to" accessible className="gap-2 rounded-3xl border border-outline bg-surface p-5">
        <AppText variant="label" tone="muted">
          {t('payment:review.to')}
        </AppText>
        <AppText variant="title">{t('payment:review.phone', { code: review.receiverCode })}</AppText>
        {review.receiverIsNew ? <Chip kind="waiting" label={t('payment:review.newPhone')} /> : null}
        <AppText variant="label" tone="muted">
          {t('payment:review.compare')}
        </AppText>
      </View>

      {review.memo ? (
        <View testID="pay-note" accessible className="gap-1 rounded-3xl border border-outline bg-surface p-5">
          <AppText variant="body">{`“${review.memo}”`}</AppText>
          <AppText variant="label" tone="muted">
            {t('payment:review.noteWarning')}
          </AppText>
        </View>
      ) : null}

      <View testID="pay-from" accessible className="gap-1 rounded-3xl border border-outline bg-surface p-5">
        <AppText variant="label" tone="muted">
          {t('payment:review.from')}
        </AppText>
        <AppText variant="title">{passedOn ? t('payment:review.sourceReceived') : t('payment:review.source')}</AppText>
        {'spend' in plan ? (
          <>
            {plan.review.fee > 0n ? (
              <StatusNote
                tone="default"
                message={t('payment:review.includesFee', { fee: money(plan.review.fee), symbol: review.symbol })}
              />
            ) : null}
            {plan.review.change > 0n ? (
              <StatusNote
                tone="default"
                message={t('payment:review.changeBack', { change: money(plan.review.change), symbol: review.symbol })}
              />
            ) : null}
          </>
        ) : (
          <AppText variant="body" tone="muted">
            {t('payment:review.left', { amount: money(review.allowanceAfter ?? 0n), symbol: review.symbol })}
          </AppText>
        )}
        {event ? <StatusNote tone="default" message={t('event:onlyAt', { event })} /> : null}
      </View>

      <View testID="pay-consequences" className="flex-row items-center justify-between gap-2">
        <Chip kind="info" icon="lock" label={t('payment:review.final')} />
        <Info
          title={t('payment:review.next')}
          lines={passedOn ? [...consequences, t('payment:review.bondAnswers')] : consequences}
        />
      </View>

      <View testID="pay-details">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          className="min-h-12 justify-center"
        >
          <AppText variant="label" tone="muted">
            {t('payment:review.details')}
          </AppText>
        </Pressable>
        {open ? (
          <View className="gap-1">
            {review.lockSeq === null ? null : (
              <AppText variant="body">{t('payment:review.lock', { number: review.lockSeq })}</AppText>
            )}
            <AppText variant="body">
              {t('payment:review.expires', { date: formatDateTime(review.expiry, currentLanguage()) })}
            </AppText>
            <AppText variant="body">{t('payment:review.hops', { count: hops })}</AppText>
          </View>
        ) : null}
      </View>
    </View>
  )
}

/** The buttons of the confirmation: the screen keeps them below its scrolling body, always in view. */
export function PayReviewActions({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: Plan | RespendPlan
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const { review } = plan
  const [pressed, setPressed] = useState(false)
  const values = { amount: formatMoney(review.amount, review.decimals, currentLanguage()), symbol: review.symbol }
  const label = review.biometric ? t('payment:review.confirmAndPay', values) : t('payment:review.pay', values)

  return (
    <View className="gap-3">
      {review.biometric ? <Chip kind="info" icon="fingerprint" label={t('payment:review.fingerprint')} /> : null}
      <Button
        testID="pay-confirm"
        variant="filled"
        label={label}
        busy={busy || pressed}
        disabled={busy || pressed}
        onPress={() => {
          if (pressed) return
          setPressed(true)
          onConfirm()
        }}
      />
      <Button
        testID="pay-cancel"
        variant="text"
        label={t('payment:review.cancel')}
        disabled={busy || pressed}
        onPress={onCancel}
      />
    </View>
  )
}
