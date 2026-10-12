import { bytesToHex } from '@noble/hashes/utils.js'
import { getAddressEncoder } from '@solana/kit'
import { useCallback, useMemo, useRef, useState } from 'react'
import { deviceKeyCluster } from '../../keys'
import { domain, Purpose } from '../../protocol'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { genesisHashOf } from '../../payment/domains'
import { GroupError } from '../../transport/nearby/group'
import { useDebts } from '../debts/use-debts'
import { type Invite, encodeInvite, decodeInvite, newInvite } from './channel'
import { runHost } from './host'
import {
  DEFAULT_TIMEOUTS,
  type ProposalView,
  runMember,
  type SessionDeps,
  type SessionEvent,
  type SessionOutcome,
} from './member'
import { openHub, openSpoke } from './open-group'
import { proveNetting, verifyNettingProof } from './prove'
import { type SessionView, sessionView, viewOfOutcome } from './session-view'

const PROGRAM = getAddressEncoder().encode(ACTIVE_PROFILE.programId as never)

export type SessionRun = {
  view: SessionView | undefined
  consent: ProposalView | undefined
  outcome: SessionOutcome | undefined
  failure: { reason: GroupError['reason']; count: number } | undefined
  phase: 'idle' | 'scan' | 'connecting' | 'not-found' | 'running'
}

/** The deps both roles share, built from the debts context of the app; `undefined` until the store and key are ready. */
function useDeps(onEvent: (event: SessionEvent) => void, consent: SessionDeps['consent']): SessionDeps | undefined {
  const debts = useDebts()
  const cluster = deviceKeyCluster()
  return useMemo(() => {
    if (!debts || !cluster) return undefined
    return {
      db: debts.db,
      now: debts.now,
      random: debts.random,
      domains: {
        iou: debts.iouDomain,
        netting: domain(Purpose.Netting, genesisHashOf(cluster), Uint8Array.from(PROGRAM)),
      },
      programId: Uint8Array.from(PROGRAM),
      mint: debts.mint,
      deviceKey: debts.me,
      signIou: debts.sign,
      verifyProof: (statement, proof) => verifyNettingProof(statement, proof),
      consent,
      onEvent,
      timeouts: DEFAULT_TIMEOUTS,
    }
  }, [debts, cluster, consent, onEvent])
}

function useRun(role: 0 | 1) {
  const [run, setRun] = useState<SessionRun>({
    view: undefined,
    consent: undefined,
    outcome: undefined,
    failure: undefined,
    phase: 'idle',
  })
  const decide = useRef<((ok: boolean) => void) | undefined>(undefined)
  const count = useRef(0)
  const failures = useRef(0)
  const consent = useCallback(
    (view: ProposalView) =>
      new Promise<boolean>((resolve) => {
        decide.current = resolve
        setRun((r) => ({ ...r, consent: view }))
      }),
    [],
  )
  const onEvent = useCallback(
    (event: SessionEvent) => {
      if (event.type === 'joined') count.current = event.count
      setRun((r) => {
        if (event.type === 'joined')
          return {
            ...r,
            view: sessionView(
              {
                status: 0,
                role: 0,
                expires: null,
                proof: null,
                nothing: false,
                recordPending: false,
                remainder: [],
                count: event.count,
              },
              0,
            ),
          }
        if (event.type === 'phase')
          return {
            ...r,
            view: sessionView(
              {
                status: event.status,
                role,
                expires: r.view?.expiresAt ?? null,
                proof: null,
                nothing: false,
                recordPending: false,
                remainder: [],
              },
              0,
            ),
          }
        if (event.type === 'ended')
          return { ...r, outcome: event.outcome, consent: undefined, view: viewOfOutcome(event.outcome, 0) }
        return r
      })
    },
    [role],
  )
  return { run, setRun, decide, consent, onEvent, failures, count }
}

/** Hosts a session: shows the invite, runs the host until the person presses Start. */
export function useHostSession() {
  const state = useRun(0)
  const deps = useDeps(state.onEvent, state.consent)
  const controller = useRef(new AbortController())
  const release = useRef<(() => void) | undefined>(undefined)
  const opened = useRef(false)
  const [invite, setInvite] = useState<Invite>()
  const { setRun, failures } = state

  const open = useCallback(async () => {
    if (!deps || opened.current) return
    opened.current = true
    const next = newInvite(deps.random)
    setInvite(next)
    try {
      const wire = await openHub(next)
      setRun((r) => ({
        ...r,
        phase: 'running',
        view: sessionView(
          {
            status: 0,
            role: 0,
            expires: null,
            proof: null,
            nothing: false,
            recordPending: false,
            remainder: [],
            count: 1,
          },
          0,
        ),
      }))
      const start = new Promise<void>((resolve) => (release.current = resolve))
      void runHost(
        {
          ...deps,
          wire,
          mint: deps.mint,
          prove: (session, witness, signal) => proveNetting(bytesToHex(session), witness, signal),
          start,
        },
        next,
        controller.current.signal,
      ).finally(() => void wire.close())
    } catch (error) {
      if (!(error instanceof GroupError)) throw error
      failures.current++
      setRun((r) => ({ ...r, failure: { reason: error.reason, count: failures.current } }))
    }
  }, [deps, setRun, failures])

  return {
    ...state.run,
    invite: invite ? encodeInvite(invite) : undefined,
    open,
    start: () => {
      setRun((r) => ({
        ...r,
        view: sessionView(
          {
            status: 0,
            role: 0,
            expires: null,
            proof: null,
            nothing: false,
            recordPending: false,
            remainder: [],
            collecting: true,
          },
          0,
        ),
      }))
      release.current?.()
    },
    cancel: () => controller.current.abort(),
    answer: (ok: boolean) => state.decide.current?.(ok),
  }
}

/** Joins the session an invite names. */
export function useJoinSession() {
  const state = useRun(1)
  const deps = useDeps(state.onEvent, state.consent)
  const controller = useRef(new AbortController())

  const join = useCallback(
    async (text: string) => {
      if (!deps) return
      let invite: Invite
      try {
        invite = decodeInvite(text)
      } catch {
        return
      }
      state.setRun((r) => ({ ...r, phase: 'connecting' }))
      try {
        const wire = await openSpoke(invite, controller.current.signal)
        state.setRun((r) => ({
          ...r,
          phase: 'running',
          view: sessionView(
            {
              status: 0,
              role: 1,
              expires: null,
              proof: null,
              nothing: false,
              recordPending: false,
              remainder: [],
              joined: true,
            },
            0,
          ),
        }))
        void runMember({ ...deps, wire }, invite, controller.current.signal).finally(() => void wire.close())
      } catch (error) {
        if (!(error instanceof GroupError)) throw error
        state.setRun((r) => ({ ...r, phase: 'not-found' }))
      }
    },
    [deps, state],
  )
  return {
    ...state.run,
    join,
    cancel: () => controller.current.abort(),
    answer: (ok: boolean) => state.decide.current?.(ok),
  }
}
