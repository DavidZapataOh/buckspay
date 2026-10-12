import { formatDateTime } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { ListRow } from '../../components/list-row'
import { Screen } from '../../components/screen'
import { type ActivityDetail, activityDetail } from '../../features/notes/activity'
import { LostNote } from '../../features/activity/lost-note'
import { RemoteStatus } from '../../features/remote/remote-status'
import { sentence, parseActivityId } from '../../features/activity/format'
import { PAY_LIMITS, MIN_WINDOW } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { usePayments } from '../../features/payment/payments-provider'
import { reasonText } from '../../features/payment/reason-text'
import type { Reason } from '../../payment/reasons'
import { whyWaiting } from '../../features/settlement/why'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { ellipsify } from '../../utils/ellipsify'

export default function ActivityDetailScreen() {
  const { t } = useTranslation(NAMESPACES)

  const { id } = useLocalSearchParams<{ id: string }>()
  const { db } = usePayments()
  const settlement = useSettlementRunner()
  const flow = usePayFlow()
  const [detail, setDetail] = useState<ActivityDetail>()
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

  return (
    <Screen testID="activity-detail">
      <AppText variant="headline">{t('payment:activity.detail')}</AppText>
      <AppText variant="body">{sentence({ ...detail }, symbol, decimals)}</AppText>
      <ListRow title={t('payment:activity.id')} value={ellipsify(bytesToHex(detail.id), 8)} />
      <ListRow title={t('payment:activity.time')} value={formatDateTime(detail.at, currentLanguage())} />
      {detail.remote && detail.deadline !== undefined ? (
        <RemoteStatus state={detail.state} passedTo={detail.handedTo ?? 0} deadline={detail.deadline} />
      ) : null}
      {detail.transport ? <ListRow title={t('payment:activity.transport')} value={detail.transport} /> : null}
      {detail.memo ? <ListRow title={t('payment:activity.note')} value={`“${detail.memo}”`} /> : null}
      {detail.reason ? (
        <ListRow
          title={t('payment:activity.reason')}
          value={reasonText(detail.reason as Reason, {
            window: MIN_WINDOW,
            max: PAY_LIMITS.maxPayment,
            symbol,
            decimals,
          })}
        />
      ) : null}
      {detail.locks && detail.locks.length > 0 ? (
        <ListRow title={t('payment:activity.locks')} value={detail.locks.join(', ')} />
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
        <AppText variant="body" tone="muted" accessibilityLiveRegion="polite">
          {waiting}
        </AppText>
      ) : null}
      {why?.code ? (
        <AppText variant="label" tone="muted">
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
        {why?.action === 'settle-in-clear' && detail.outputId ? (
          <Button
            testID="settle-in-clear"
            variant="tonal"
            label={t('payment:activity.settleInClear')}
            onPress={() => detail.outputId && void settlement.confirmNotice(detail.outputId)}
          />
        ) : null}
        {detail.kind === 'paid' && detail.unfinished ? (
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
    </Screen>
  )
}
