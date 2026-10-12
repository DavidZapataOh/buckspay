import type { ProposalView } from '../member'
import type { RemainderRow } from '../remainder-section'
import { type SessionState, type SessionView, sessionView } from '../session-view'

const NOW = 1_800_000_000
const U = 1_000_000n
const STATUS: Record<SessionState, number> = {
  lobby: 0,
  collecting: 0,
  connecting: 0,
  consent: 1,
  waiting: 2,
  agreed: 3,
  recorded: 4,
  void: 5,
  abandoned: 6,
  undecided: 7,
  nothing: 3,
}

const view = (state: SessionState, over: Partial<{ proof: SessionView['proof']; recordPending: boolean }> = {}) =>
  sessionView(
    {
      status: STATUS[state],
      role: 1,
      expires: NOW + 86_400,
      proof: null,
      nothing: state === 'nothing',
      recordPending: false,
      remainder: [],
      ...over,
    },
    NOW,
  )

/** Fixed screen inputs; tests only. */
export const fixtures = {
  view,
  lobby: (count: number) =>
    sessionView(
      { status: 0, role: 0, expires: null, proof: null, nothing: false, recordPending: false, remainder: [], count },
      NOW,
    ),
  recent: (['agreed', 'recorded', 'void'] as const).map((state, i) => ({ id: String(i), view: view(state) })),
  consent: {
    tabs: [
      {
        tab: new Uint8Array(32).fill(1),
        peerIndex: 0,
        direction: 'owesMe',
        amount: 10n * U,
        cancel: 5n * U,
        remaining: 5n * U,
        due: 1_800_000_000,
      },
      {
        tab: new Uint8Array(32).fill(2),
        peerIndex: 2,
        direction: 'iOwe',
        amount: 7n * U,
        cancel: 5n * U,
        remaining: 2n * U,
        due: 0,
      },
    ],
    netBefore: 3n * U,
    netAfter: 3n * U,
    participants: 3,
    total: 15n * U,
    expires: NOW + 259_200,
  } satisfies ProposalView,
  remainderRows: [
    { tab: 'a0', role: 'debtor', amount: 5n * U, state: 'due' },
    { tab: 'a1', role: 'creditor', amount: 5n * U, state: 'released' },
    { tab: 'a2', role: 'creditor', amount: 5n * U, state: 'settled' },
    { tab: 'a3', role: 'creditor', amount: 2n * U, state: 'void' },
    { tab: 'a4', role: 'creditor', amount: 5n * U, state: 'undecided' },
    { tab: 'a5', role: 'creditor', amount: 5n * U, state: 'unknown' },
  ] satisfies RemainderRow[],
  simplify: { id: 's1', path: 'A → B → C', from: 'A', to: 'C' },
  noopHandlers: {
    onPay: () => undefined,
    onLater: () => undefined,
    onClaimOptions: () => undefined,
    onSettleTogether: () => undefined,
    onApproveSimplify: () => undefined,
    onPayFee: () => undefined,
  },
  otherPeoplesSafetyCode: 'ZZZZ-9999',
}
