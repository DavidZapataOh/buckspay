import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { Plan } from '../../payment/preflight'
import { formatMoney } from '../../utils/format-amount'
import { copy, text } from '../payment/copy'
import { useTouchGuard } from './use-touch-guard'

/**
 * The confirmation screen's body, and the only way to a signature. It reads the plan alone, which was
 * made from the issue that will be signed: nothing on it can differ from what is signed.
 */
export function PayReview({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: Plan
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { review, issue } = plan
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
        <AppText variant="title">{copy.review.source}</AppText>
        <AppText variant="body" tone="muted">
          {text(copy.review.left, {
            amount: formatMoney(review.allowanceAfter, review.decimals),
            symbol: review.symbol,
          })}
        </AppText>
      </View>

      <View testID="pay-consequences" className="gap-2">
        <AppText variant="label" tone="muted">
          {copy.review.next}
        </AppText>
        {[copy.review.finalForThem, copy.review.nothingLeaves, copy.review.ifRefused].map((line) => (
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
            <AppText variant="body">{text(copy.review.lock, { number: review.lockSeq })}</AppText>
            <AppText variant="body">
              {text(copy.review.expires, { date: new Date(review.expiry * 1000).toLocaleString() })}
            </AppText>
            <AppText variant="body">{text(copy.review.hops, { hops: issue.caveats.hopsLeft })}</AppText>
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
