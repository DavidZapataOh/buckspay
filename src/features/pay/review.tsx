import { formatDateTime, formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
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

  const amount = formatMoney(review.amount, review.decimals, currentLanguage())
  const values = { amount, symbol: review.symbol }

  return (
    <View className="gap-6">
      <AppText testID="pay-review" variant="headline">
        {t('payment:review.title', values)}
      </AppText>
      {nearbyCheck ? (
        <AppText testID="pay-nearby-check" variant="label" tone="muted">
          {t('witness:reviewAsks')}
        </AppText>
      ) : null}

      <View testID="pay-to" accessible className="gap-1">
        <AppText variant="label" tone="muted">
          {t('payment:review.to')}
        </AppText>
        <AppText variant="title">{t('payment:review.phone', { code: review.receiverCode })}</AppText>
        {review.receiverIsNew ? (
          <AppText variant="label" tone="danger">
            {t('payment:review.newPhone')}
          </AppText>
        ) : null}
        <AppText variant="body" tone="muted">
          {t('payment:review.compare')}
        </AppText>
      </View>

      {review.memo ? (
        <View testID="pay-note" accessible className="gap-1">
          <AppText variant="label" tone="muted">
            {t('payment:review.note')}
          </AppText>
          <AppText variant="body">{`“${review.memo}”`}</AppText>
          <AppText variant="label" tone="muted">
            {t('payment:review.noteWarning')}
          </AppText>
        </View>
      ) : null}

      <View testID="pay-from" accessible className="gap-1">
        <AppText variant="label" tone="muted">
          {t('payment:review.from')}
        </AppText>
        <AppText variant="title">{passedOn ? t('payment:review.sourceReceived') : t('payment:review.source')}</AppText>
        {'spend' in plan ? (
          <>
            <StatusNote tone="default" message={t('payment:review.fromReceived')} />
            {plan.review.fee > 0n ? (
              <StatusNote
                tone="default"
                message={t('payment:review.includesFee', {
                  fee: formatMoney(plan.review.fee, review.decimals, currentLanguage()),
                  symbol: review.symbol,
                })}
              />
            ) : null}
            {plan.review.change > 0n ? (
              <StatusNote
                tone="default"
                message={t('payment:review.changeBack', {
                  change: formatMoney(plan.review.change, review.decimals, currentLanguage()),
                  symbol: review.symbol,
                })}
              />
            ) : null}
            <AppText variant="body" tone="muted">
              {t('payment:review.bondAnswers')}
            </AppText>
          </>
        ) : (
          <AppText variant="body" tone="muted">
            {t('payment:review.left', {
              amount: formatMoney(review.allowanceAfter ?? 0n, review.decimals, currentLanguage()),
              symbol: review.symbol,
            })}
          </AppText>
        )}
        {event ? <StatusNote tone="default" message={t('event:onlyAt', { event })} /> : null}
      </View>

      <View testID="pay-consequences" className="gap-2">
        <AppText variant="label" tone="muted">
          {t('payment:review.next')}
        </AppText>
        {(passedOn
          ? [t('payment:review.finalForThem'), t('payment:review.ifRefusedReceived')]
          : [t('payment:review.finalForThem'), t('payment:review.nothingLeaves'), t('payment:review.ifRefused')]
        ).map((line) => (
          <AppText key={line} variant="body">
            {line}
          </AppText>
        ))}
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
      {review.biometric ? (
        <AppText variant="body" tone="muted">
          {t('payment:review.fingerprint')}
        </AppText>
      ) : null}
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
