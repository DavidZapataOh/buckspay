import { bytesToHex } from '@noble/hashes/utils.js'
import { getAddressEncoder } from '@solana/kit'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deviceKeyCluster } from '../../keys'
import { domain, Purpose } from '../../protocol'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { genesisHashOf } from '../../payment/domains'
import { GroupError, type GroupWire } from '../../transport/nearby/group'
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
import { collectRemainder, type RemainderTab } from './remainder'
import { startRemainder } from './remainder-run'
import { loadRemainderRows, remainderTabsOf } from './remainder-rows'
import type { RemainderRow } from './remainder-section'
import type { SessionPort } from './session-port'
import { useRemainderDeps } from './use-remainder-deps'
import { type SessionView, sessionView, viewOfOutcome } from './session-view'

const PROGRAM = getAddressEncoder().encode(ACTIVE_PROFILE.programId as never)

export type SessionRun = {
  view: SessionView | undefined
  consent: ProposalView | undefined
  outcome: SessionOutcome | undefined
  failure: { reason: GroupError['reason']; count: number } | undefined
  /** What is left to pay once the session ended, one row for every tab of this phone that has something left. */
  remainder: readonly RemainderRow[]
  phase: 'idle' | 'scan' | 'connecting' | 'not-found' | 'running'
}

/** The deps both roles share, built from the debts context of the app; `undefined` until the store and key are ready. */
function useDeps(
  onEvent: (event: SessionEvent) => void,
  consent: SessionDeps['consent'],
  onLink: (port: SessionPort) => void,
): SessionDeps | undefined {
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
      onLink,
      timeouts: DEFAULT_TIMEOUTS,
    }
  }, [debts, cluster, consent, onEvent, onLink])
}

function useRun(role: 0 | 1) {
  const [run, setRun] = useState<SessionRun>({
    view: undefined,
    consent: undefined,
    outcome: undefined,
    failure: undefined,
    remainder: [],
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

/**
 * What a phone keeps while a finished session still has something left to pay: the link of the session and what it
 * does with it. Everything is let go when the person leaves the screen or there is nothing left to do.
 */
function useRemainder(setRows: (rows: RemainderRow[]) => void) {
  const depsFor = useRemainderDeps()
  const port = useRef<SessionPort>(undefined)
  const wire = useRef<GroupWire>(undefined)
  const run = useRef<ReturnType<typeof startRemainder>>(undefined)
  const release = useCallback(() => {
    run.current?.stop()
    run.current = undefined
    port.current?.close()
    port.current = undefined
    void wire.current?.close()
    wire.current = undefined
  }, [])
  useEffect(() => release, [release])

  const onLink = useCallback((next: SessionPort) => {
    port.current = next
  }, [])
  const begin = useCallback(
    (session: Uint8Array, tabs: RemainderTab[], db: SessionDeps['db']) => {
      const deps = depsFor && port.current ? depsFor(session, port.current) : undefined
      if (!deps || tabs.length === 0) return release()
      run.current = startRemainder({
        deps,
        tabs,
        refresh: async () => setRows(await loadRemainderRows(db, session, tabs)),
        close: () => undefined,
      })
    },
    [depsFor, release, setRows],
  )
  return {
    onLink,
    hold: (next: GroupWire) => {
      wire.current = next
    },
    begin,
    release,
    pay: (tab: string) => void run.current?.pay(tab),
    later: (tab: string) => void run.current?.later(tab),
  }
}

/** Writes down what is left to pay of every tab of this phone and returns it as the screen shows it. */
async function afterSession(
  deps: SessionDeps,
  session: Uint8Array,
  outcome: SessionOutcome,
): Promise<{ tabs: RemainderTab[]; rows: RemainderRow[] }> {
  const tabs = await remainderTabsOf(deps.db, { session, deviceKey: deps.deviceKey, mint: deps.mint, outcome })
  await collectRemainder(deps.db, session, tabs)
  return { tabs, rows: await loadRemainderRows(deps.db, session, tabs) }
}

/** Hosts a session: shows the invite, runs the host until the person presses Start. */
export function useHostSession() {
  const state = useRun(0)
  const { setRun, failures } = state
  const rows = useCallback((next: RemainderRow[]) => setRun((r) => ({ ...r, remainder: next })), [setRun])
  const remainder = useRemainder(rows)
  const deps = useDeps(state.onEvent, state.consent, remainder.onLink)
  const controller = useRef(new AbortController())
  const release = useRef<(() => void) | undefined>(undefined)
  const opened = useRef(false)
  const [invite, setInvite] = useState<Invite>()

  const open = useCallback(async () => {
    if (!deps || opened.current) return
    opened.current = true
    const next = newInvite(deps.random)
    setInvite(next)
    try {
      const wire = await openHub(next)
      remainder.hold(wire)
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
      )
        .then((outcome) => afterSession(deps, next.session, outcome))
        .then(({ tabs, rows }) => {
          setRun((r) => ({ ...r, remainder: rows }))
          remainder.begin(next.session, tabs, deps.db)
        })
        .catch((error) => {
          console.warn('The session ended but its remainder could not be read.', error)
          remainder.release()
        })
    } catch (error) {
      if (!(error instanceof GroupError)) throw error
      failures.current++
      setRun((r) => ({ ...r, failure: { reason: error.reason, count: failures.current } }))
    }
  }, [deps, setRun, failures, remainder])

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
    cancel: () => {
      controller.current.abort()
      remainder.release()
    },
    answer: (ok: boolean) => state.decide.current?.(ok),
    onPay: remainder.pay,
    onLater: remainder.later,
  }
}

/** Joins the session an invite names. */
export function useJoinSession() {
  const state = useRun(1)
  const { setRun } = state
  const rows = useCallback((next: RemainderRow[]) => setRun((r) => ({ ...r, remainder: next })), [setRun])
  const remainder = useRemainder(rows)
  const deps = useDeps(state.onEvent, state.consent, remainder.onLink)
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
        remainder.hold(wire)
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
        void runMember({ ...deps, wire }, invite, controller.current.signal)
          .then((outcome) => afterSession(deps, invite.session, outcome))
          .then(({ tabs, rows }) => {
            state.setRun((r) => ({ ...r, remainder: rows }))
            remainder.begin(invite.session, tabs, deps.db)
          })
          .catch((error) => {
            console.warn('The session ended but its remainder could not be read.', error)
            remainder.release()
          })
      } catch (error) {
        if (!(error instanceof GroupError)) throw error
        state.setRun((r) => ({ ...r, phase: 'not-found' }))
      }
    },
    [deps, state, remainder],
  )
  return {
    ...state.run,
    join,
    cancel: () => {
      controller.current.abort()
      remainder.release()
    },
    answer: (ok: boolean) => state.decide.current?.(ok),
    onPay: remainder.pay,
    onLater: remainder.later,
  }
}
