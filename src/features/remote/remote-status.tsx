import { formatDateTime } from '../../i18n/format'
import { currentLanguage, NAMESPACES, translateIfKnown } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { ListRow } from '../../components/list-row'
import { AppText } from '../../components/app-text'

/** The detail of a payment to someone far away: where it stands, how many phones took it, and when it stops being payable. */
export function RemoteStatus({
  state,
  passedTo,
  deadline,
}: {
  /** `remote-` and the state of the delivery. */
  state: string
  passedTo: number
  deadline: number
}) {
  const { t } = useTranslation(NAMESPACES)

  const known = state.slice(7)
  return (
    <>
      <ListRow title={t('remote:detail.status')} value={translateIfKnown(`remote:status.${known}`) ?? state} />
      {passedTo > 0 ? (
        <ListRow
          title={t('remote:detail.passed')}
          value={passedTo === 1 ? t('remote:detail.passedToOne') : t('remote:detail.passedTo', { count: passedTo })}
        />
      ) : null}
      <ListRow
        title={t('remote:detail.deadlineTitle')}
        value={t('remote:detail.deadline', { deadline: formatDateTime(deadline, currentLanguage()) })}
      />
      {known === 'expired' ? (
        <AppText variant="body" tone="muted">
          {t('remote:detail.expiredNote')}
        </AppText>
      ) : null}
    </>
  )
}
