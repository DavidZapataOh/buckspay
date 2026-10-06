import { ListRow } from '../../components/list-row'
import { AppText } from '../../components/app-text'
import { text } from '../payment/copy'
import { remoteCopy } from './copy'

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
  const known = state.slice(7) as keyof typeof remoteCopy.status
  return (
    <>
      <ListRow title={remoteCopy.detail.status} value={remoteCopy.status[known] ?? state} />
      {passedTo > 0 ? (
        <ListRow
          title={remoteCopy.detail.passed}
          value={passedTo === 1 ? remoteCopy.detail.passedToOne : text(remoteCopy.detail.passedTo, { count: passedTo })}
        />
      ) : null}
      <ListRow
        title={remoteCopy.detail.deadlineTitle}
        value={text(remoteCopy.detail.deadline, { deadline: new Date(deadline * 1000).toLocaleString() })}
      />
      {known === 'expired' ? (
        <AppText variant="body" tone="muted">
          {remoteCopy.detail.expiredNote}
        </AppText>
      ) : null}
    </>
  )
}
