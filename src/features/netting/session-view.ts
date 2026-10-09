import { fill, nettingCopy } from './copy'

export type SessionState =
  | 'lobby'
  | 'collecting'
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
  },
  now: number,
  locale?: string,
): SessionView {
  void now
  const state: SessionState = input.nothing
    ? 'nothing'
    : input.role === 0 && input.status === 0
      ? 'lobby'
      : BY_STATUS[input.status]
  const time = input.expires === null ? '' : new Date(input.expires * 1000).toLocaleString(locale)
  const text = nettingCopy.states[state]
  let body = fill(text.body, { expires: time, time, count: input.count ?? 0 })
  if (state === 'agreed' && input.recordPending) body = `${body} ${nettingCopy.recording}`
  return {
    state,
    tone: state === 'agreed' && input.proof && input.proof !== 'valid' ? 'default' : TONES[state],
    headline: text.headline,
    body,
    expiresAt: input.expires,
    count: input.count ?? 0,
    proof: input.proof,
    remainder: input.remainder,
  }
}
