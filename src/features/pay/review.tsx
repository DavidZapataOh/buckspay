import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { StatusNote } from '../../components/status-note'
import type { Plan } from '../../payment/preflight'
import type { RespendPlan } from '../../payment/respend'
import { formatMoney } from '../../utils/format-amount'
import { eventCopy } from '../event/copy'
import { copy, text } from '../payment/copy'
import { witnessCopy } from '../witness/copy'
import { useTouchGuard } from './use-touch-guard'

/**
 * The confirmation screen's body, and the only way to a signature. It reads the plan alone, which was
 * made from the issue that will be signed: nothing on it can differ from what is signed.
 */
export function PayReview({
  plan,
  busy,
  event,
  nearbyCheck = false,
  onConfirm,
  onCancel,
}: {
  plan: Plan | RespendPlan
  busy: boolean
  /** The event whose credit this is, when the payment sells event credit. */
  event?: string
  /** The receiver will ask for a nearby check after this payment. */
  nearbyCheck?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { review } = plan
  const passedOn = 'spend' in plan
  const hops = 'issue' in plan ? plan.issue.caveats.hopsLeft : plan.review.hopsAfter
  const [pressed, setPressed] = useState(false)
  const [open, setOpen] = useState(false)
  useTouchGuard(true)

  const amount = formatMoney(review.amount, review.decimals)
  const values = { amount, symbol: review.symbol }
  const label = review.biometric ? copy.review.confirmAndPay : copy.review.pay

  return (
    <View className="gap-6">
      <AppText testID="pay-review" variant="headline">
        {text(copy.review.title, values)}
      </AppText>
      {nearbyCheck ? (
        <AppText testID="pay-nearby-check" variant="label" tone="muted">
          {witnessCopy.reviewAsks}
        </AppText>
      ) : null}

      <View testID="pay-to" accessible className="gap-1">
        <AppText variant="label" tone="muted">
          {copy.review.to}
        </AppText>
        <AppText variant="title">{text(copy.review.phone, { code: review.receiverCode })}</AppText>
        {review.receiverIsNew ? (
          <AppText variant="label" tone="danger">
            {copy.review.newPhone}
          </AppText>
        ) : null}
        <AppText variant="body" tone="muted">
          {copy.review.compare}
        </AppText>
      </View>

      {review.memo ? (
        <View testID="pay-note" accessible className="gap-1">
          <AppText variant="label" tone="muted">
            {copy.review.note}
          </AppText>
          <AppText variant="body">{`“${review.memo}”`}</AppText>
          <AppText variant="label" tone="muted">
            {copy.review.noteWarning}
          </AppText>
        </View>
      ) : null}

      <View testID="pay-from" accessible className="gap-1">
        <AppText variant="label" tone="muted">
          {copy.review.from}
        </AppText>
        <AppText variant="title">{passedOn ? copy.review.sourceReceived : copy.review.source}</AppText>
        {'spend' in plan ? (
          <>
            <StatusNote tone="default" message={copy.review.fromReceived} />
            {plan.review.fee > 0n ? (
              <StatusNote
                tone="default"
                message={text(copy.review.includesFee, {
                  fee: formatMoney(plan.review.fee, review.decimals),
                  symbol: review.symbol,
                })}
              />
            ) : null}
            {plan.review.change > 0n ? (
              <StatusNote
                tone="default"
                message={text(copy.review.changeBack, {
                  change: formatMoney(plan.review.change, review.decimals),
                  symbol: review.symbol,
                })}
              />
            ) : null}
            <AppText variant="body" tone="muted">
              {copy.review.bondAnswers}
            </AppText>
          </>
        ) : (
          <AppText variant="body" tone="muted">
            {text(copy.review.left, {
              amount: formatMoney(review.allowanceAfter ?? 0n, review.decimals),
              symbol: review.symbol,
            })}
          </AppText>
        )}
        {event ? <StatusNote tone="default" message={text(eventCopy.onlyAt, { event })} /> : null}
      </View>

      <View testID="pay-consequences" className="gap-2">
        <AppText variant="label" tone="muted">
          {copy.review.next}
        </AppText>
        {(passedOn
          ? [copy.review.finalForThem, copy.review.ifRefusedReceived]
          : [copy.review.finalForThem, copy.review.nothingLeaves, copy.review.ifRefused]
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
            {copy.review.details}
          </AppText>
        </Pressable>
        {open ? (
          <View className="gap-1">
            {review.lockSeq === null ? null : (
              <AppText variant="body">{text(copy.review.lock, { number: review.lockSeq })}</AppText>
            )}
            <AppText variant="body">
              {text(copy.review.expires, { date: new Date(review.expiry * 1000).toLocaleString() })}
            </AppText>
            <AppText variant="body">{text(copy.review.hops, { hops })}</AppText>
          </View>
        ) : null}
      </View>

      {review.biometric ? (
        <AppText variant="body" tone="muted">
          {copy.review.fingerprint}
        </AppText>
      ) : null}
      <View className="gap-3">
        <Button
          testID="pay-confirm"
          variant="filled"
          label={text(label, values)}
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
          label={copy.review.cancel}
          disabled={busy || pressed}
          onPress={onCancel}
        />
      </View>
    </View>
  )
}
