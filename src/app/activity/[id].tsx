import { formatDateTime, formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Hero } from '../../components/hero'
import { ListRow } from '../../components/list-row'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { type ActivityDetail, activityDetail } from '../../features/notes/activity'
import { LostNote } from '../../features/activity/lost-note'
import { RemoteStatus } from '../../features/remote/remote-status'
import { parseActivityId, statusKind, statusWord } from '../../features/activity/format'
import { PAY_LIMITS, MIN_WINDOW } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { usePayments } from '../../features/payment/payments-provider'
import { reasonText } from '../../features/payment/reason-text'
import type { Reason } from '../../payment/reasons'
import { safetyCode } from '../../payment/messages'
import { whyWaiting } from '../../features/settlement/why'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { ellipsify } from '../../utils/ellipsify'

const HEROES = { done: 'done', problem: 'problem', waiting: 'waiting', info: 'waiting' } as const

export default function ActivityDetailScreen() {
  const { t } = useTranslation(NAMESPACES)

  const { id } = useLocalSearchParams<{ id: string }>()
  const { db } = usePayments()
  const settlement = useSettlementRunner()
  const flow = usePayFlow()
  const [detail, setDetail] = useState<ActivityDetail>()
  const [open, setOpen] = useState(false)
  const parsed = parseActivityId(id)

  const { report } = settlement
  useEffect(() => {
    if (!db || !parsed) return
    let current = true
    void activityDetail(db, parsed.kind, parsed.id).then((found) => current && setDetail(found))
    return () => {
      current = false
    }
    // `parsed` is derived from `id`; the row is read again when a settlement run reports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, id, report])

  if (!detail) return <Screen testID="activity-detail">{null}</Screen>

  const { symbol, decimals } = BUILD_TOKEN
  const lost = settlement.report?.lost.find(
    ({ outputId }) => detail.outputId && bytesToHex(outputId) === bytesToHex(detail.outputId),
  )
  const settleable =
    detail.kind === 'received' &&
    (detail.state === 'held' || detail.state === 'passable' || detail.state === 'settling')
  const why = settleable && detail.outputId ? whyWaiting(settlement.report, detail.outputId) : undefined
  const waiting =
    detail.keepUntil !== undefined
      ? t('payment:activity.passOnUntil', { time: formatDateTime(detail.keepUntil, currentLanguage()) })
      : (why?.text ?? (detail.state === 'expired' ? t('payment:activity.expiredNote') : undefined))
  const kind = statusKind(detail.state)
  const paid = detail.kind === 'paid'

  return (
    <Screen testID="activity-detail">
      <Stage
        hero={<Hero kind={HEROES[kind]} decorative size={120} />}
        title={statusWord(detail)}
        tone={kind === 'done' ? 'success' : kind === 'problem' ? 'danger' : undefined}
      >
        <Amount
          value={`${paid ? '−' : '+'}${formatMoney(detail.amount, decimals, currentLanguage())}`}
          symbol={symbol}
          tone={paid ? 'strong' : 'success'}
        />
        {paid && !detail.remote ? (
          <AppText variant="label" tone="muted">
            {t('payment:review.phone', { code: safetyCode({ type: 'device', key: detail.counterparty }) })}
          </AppText>
        ) : null}
      </Stage>
      {detail.remote && detail.deadline !== undefined ? (
        <RemoteStatus state={detail.state} passedTo={detail.handedTo ?? 0} deadline={detail.deadline} />
      ) : null}
      {detail.memo ? <AppText variant="body" className="text-center">{`“${detail.memo}”`}</AppText> : null}
      {detail.reason ? (
        <AppText variant="body" tone="muted" className="text-center">
          {reasonText(detail.reason as Reason, {
            window: MIN_WINDOW,
            max: PAY_LIMITS.maxPayment,
            symbol,
            decimals,
          })}
        </AppText>
      ) : null}
      {lost?.claim.kind === 'reported' ? (
        <LostNote
          hop={lost.claim.hop}
          steps={lost.steps}
          culprit={hexToBytes(lost.claim.culprit)}
          burned={lost.claim.burned}
          decimals={decimals}
          symbol={symbol}
          state={lost.claim.state}
        />
      ) : null}
      {waiting ? (
        <AppText variant="body" tone="muted" className="text-center" accessibilityLiveRegion="polite">
          {waiting}
        </AppText>
      ) : null}
      {why?.code ? (
        <AppText variant="label" tone="muted" className="text-center">
          {t('payment:activity.details.code', { code: why.code })}
        </AppText>
      ) : null}
      <View className="gap-3">
        {settleable ? (
          <Button
            testID="settle-now"
            variant="filled"
            label={t('payment:activity.settleNow')}
            busy={settlement.running}
            onPress={() => detail.outputId && void settlement.settleNow(detail.outputId)}
          />
        ) : null}
        {why?.action === 'settle-with-wallet' && detail.outputId ? (
          <Button
            testID="settle-with-wallet"
            variant="tonal"
            label={t('payment:activity.settleWithWallet')}
            busy={settlement.running}
            onPress={() => detail.outputId && void settlement.settleWithWallet(detail.outputId)}
          />
        ) : null}
        {why?.action === 'settle-in-clear' && detail.outputId ? (
          <Button
            testID="settle-in-clear"
            variant="tonal"
            label={t('payment:activity.settleInClear')}
            onPress={() => detail.outputId && void settlement.confirmNotice(detail.outputId)}
          />
        ) : null}
        {paid && detail.unfinished ? (
          <>
            <AppText variant="body" tone="muted">
              {t('payment:pay.discardWarning')}
            </AppText>
            <Button
              testID="pay-resume"
              variant="filled"
              label={detail.state === 'signed' ? t('payment:pay.showAgain') : t('payment:pay.resume')}
              onPress={() => {
                void flow.resume(detail.id).then(() => router.push('/pay/send'))
              }}
            />
            <Button
              testID="pay-discard"
              variant="text"
              label={t('payment:pay.discard')}
              onPress={() => {
                void flow.discard(detail.id).then(() => router.back())
              }}
            />
          </>
        ) : null}
      </View>
      <Button
        testID="activity-details"
        variant="text"
        label={open ? t('common:hideDetails') : t('common:details')}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View className="gap-1">
          <ListRow title={t('payment:activity.id')} value={ellipsify(bytesToHex(detail.id), 8)} />
          <ListRow title={t('payment:activity.time')} value={formatDateTime(detail.at, currentLanguage())} />
          {detail.transport ? <ListRow title={t('payment:activity.transport')} value={detail.transport} /> : null}
          {detail.locks && detail.locks.length > 0 ? (
            <ListRow title={t('payment:activity.locks')} value={detail.locks.join(', ')} />
          ) : null}
        </View>
      ) : null}
    </Screen>
  )
}
