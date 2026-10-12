import { currentLanguage, i18n, translateIfKnown } from '../../i18n'
import { formatDateTime } from '../../i18n/format'
import type { SessionOutcome } from './member'

export type SessionState =
  | 'lobby'
  | 'collecting'
  | 'joined'
  | 'connecting'
  | 'consent'
  | 'waiting'
  | 'agreed'
  | 'recorded'
  | 'void'
  | 'undecided'
  | 'abandoned'
  | 'nothing'

export type RemainderLine = {
  tab: string
  peer: string
  role: 'debtor' | 'creditor'
  amount: bigint
  /** `netting_remainder.status`: 0 due, 1 repaid, 2 released, 3 skipped, 4 settled. */
  status: 0 | 1 | 2 | 3 | 4
}

export type SessionView = {
  state: SessionState
  tone: 'default' | 'muted' | 'danger' | 'success'
  headline: string
  /** One short line under the headline: the rest is in `body`. */
  line: string
  body: string
  expiresAt: number | null
  /** People in the lobby. */
  count: number
  proof: 'valid' | 'invalid' | 'missing' | null
  remainder: RemainderLine[]
}

const BY_STATUS: SessionState[] = [
  'connecting',
  'consent',
  'waiting',
  'agreed',
  'recorded',
  'void',
  'abandoned',
  'undecided',
]
const TONES: Record<SessionState, SessionView['tone']> = {
  lobby: 'default',
  collecting: 'muted',
  joined: 'muted',
  connecting: 'muted',
  consent: 'default',
  waiting: 'muted',
  agreed: 'default',
  recorded: 'success',
  void: 'danger',
  undecided: 'danger',
  abandoned: 'muted',
  nothing: 'muted',
}

/** What a session row means to the person. Only a chain read puts a session at recorded, void or undecided. */
export function sessionView(
  input: {
    status: number
    role: 0 | 1
    expires: number | null
    proof: SessionView['proof']
    nothing: boolean
    recordPending: boolean
    remainder: RemainderLine[]
    count?: number
    /** The host pressed Start and is collecting the tabs. */
    collecting?: boolean
    /** A member that is in the session and waits for the host to begin. */
    joined?: boolean
  },
  now: number,
): SessionView {
  void now
  const state: SessionState = input.nothing
    ? 'nothing'
    : input.collecting
      ? 'collecting'
      : input.joined
        ? 'joined'
        : input.role === 0 && input.status === 0
          ? 'lobby'
          : BY_STATUS[input.status]
  const time = input.expires === null ? '' : formatDateTime(input.expires, currentLanguage())
  let body = translateIfKnown(`netting:states.${state}.body`, { expires: time, time, count: input.count ?? 0 }) ?? ''
  if (state === 'agreed' && input.recordPending) body = `${body} ${i18n.t('netting:recording')}`
  return {
    state,
    tone: state === 'agreed' && input.proof && input.proof !== 'valid' ? 'default' : TONES[state],
    headline: i18n.t(`netting:states.${state}.headline`),
    line: translateIfKnown(`netting:states.${state}.line`) ?? '',
    body,
    expiresAt: input.expires,
    count: input.count ?? 0,
    proof: input.proof,
    remainder: input.remainder,
  }
}

/** What the person sees when the session ends: the same words as the saved session would show. */
export function viewOfOutcome(outcome: SessionOutcome, now: number): SessionView {
  const base = { role: 1 as const, expires: null, proof: null, nothing: false, recordPending: false, remainder: [] }
  switch (outcome.status) {
    case 'nothing':
      return sessionView({ ...base, status: 6, nothing: true }, now)
    case 'pending':
      return sessionView({ ...base, status: 2, expires: outcome.expires }, now)
    case 'agreed':
      return sessionView({ ...base, status: 3, expires: outcome.view.expires, proof: outcome.proof }, now)
    default:
      return sessionView({ ...base, status: 6 }, now)
  }
}

/** Which of the three steps (join, check, done) a state is in. */
export function sessionStep(state: SessionState): number {
  if (state === 'consent') return 1
  if (state === 'waiting' || state === 'agreed' || state === 'void' || state === 'undecided') return 2
  if (state === 'recorded' || state === 'nothing') return 3
  return 0
}

/** The picture of a state: a check for what is done, an alert for what went wrong, waves while people join. */
export function heroOf(view: Pick<SessionView, 'state' | 'tone'>): 'done' | 'problem' | 'waiting' | 'nearby' {
  if (view.tone === 'success') return 'done'
  if (view.tone === 'danger') return 'problem'
  return view.state === 'lobby' ? 'nearby' : 'waiting'
}
