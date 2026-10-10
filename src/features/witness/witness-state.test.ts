import { describe, expect, it } from 'vitest'
import {
  canRetry,
  initialWitnessState,
  MAX_ATTEMPTS,
  mayReleaseNow,
  type WitnessEvent,
  witnessReducer,
  type WitnessState,
} from './witness-state'

const run = (events: WitnessEvent[], from: WitnessState = initialWitnessState) => events.reduce(witnessReducer, from)
const evidence = new Uint8Array(176).fill(1)

describe('witnessReducer', () => {
  it('stays off when the policy is off, and starts checking otherwise', () => {
    expect(run([{ type: 'start', policy: 'off' }]).phase).toBe('off')
    expect(run([{ type: 'start', policy: 'auto' }])).toMatchObject({ phase: 'checking', attempts: 1 })
    expect(run([{ type: 'start', policy: 'require' }]).phase).toBe('checking')
  })

  it('ignores a second start while a check exists', () => {
    expect(
      run([
        { type: 'start', policy: 'auto' },
        { type: 'start', policy: 'auto' },
      ]).attempts,
    ).toBe(1)
  })

  it('keeps the evidence of a seen result', () => {
    const state = run([
      { type: 'start', policy: 'auto' },
      { type: 'result', result: { status: 'seen', evidence } },
    ])
    expect(state).toMatchObject({ phase: 'seen' })
    expect(state.evidence).toEqual(evidence)
  })

  it('takes not-seen and unavailable as they come', () => {
    for (const status of ['not-seen', 'unavailable', 'failed', 'low-volume'] as const) {
      expect(
        run([
          { type: 'start', policy: 'auto' },
          { type: 'result', result: { status } },
        ]).phase,
      ).toBe(status)
    }
  })

  it('lets the receiver try again after a low-volume check', () => {
    const state = run([{ type: 'result', result: { status: 'low-volume' } }], run([{ type: 'start', policy: 'auto' }]))
    expect(canRetry(state)).toBe(true)
  })

  it('lets the receiver try again after a failed check', () => {
    const state = run([{ type: 'result', result: { status: 'failed' } }], run([{ type: 'start', policy: 'auto' }]))
    expect(canRetry(state)).toBe(true)
  })

  it('lets the receiver try again after not-seen, up to the maximum, with a fresh attempt each time', () => {
    let state = run([{ type: 'start', policy: 'auto' }])
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      state = run([{ type: 'result', result: { status: 'not-seen' } }], state)
      expect(canRetry(state)).toBe(true)
      state = run([{ type: 'retry' }], state)
      expect(state).toMatchObject({ phase: 'checking', attempts: attempt + 1 })
    }
    state = run([{ type: 'result', result: { status: 'not-seen' } }], state)
    expect(canRetry(state)).toBe(false)
    expect(run([{ type: 'retry' }], state)).toEqual(state)
  })

  it('does not retry after seen, unavailable or while checking', () => {
    expect(canRetry(run([{ type: 'start', policy: 'auto' }]))).toBe(false)
    expect(
      canRetry(
        run([
          { type: 'start', policy: 'auto' },
          { type: 'result', result: { status: 'seen', evidence } },
        ]),
      ),
    ).toBe(false)
    expect(
      canRetry(
        run([
          { type: 'start', policy: 'auto' },
          { type: 'result', result: { status: 'unavailable' } },
        ]),
      ),
    ).toBe(false)
  })

  it('skip ends the check and a result that arrives afterwards changes nothing', () => {
    const state = run([
      { type: 'start', policy: 'auto' },
      { type: 'skip' },
      { type: 'result', result: { status: 'seen', evidence } },
    ])
    expect(state.phase).toBe('skipped')
    expect(state.evidence).toBeUndefined()
  })

  it('ignores a result with no check running', () => {
    expect(run([{ type: 'result', result: { status: 'seen', evidence } }]).phase).toBe('off')
  })
})

describe('mayReleaseNow', () => {
  it('never holds anything back unless the check is required', () => {
    for (const policy of ['off', 'auto'] as const)
      expect(mayReleaseNow(policy, run([{ type: 'start', policy }]))).toBe(true)
  })

  it('holds a required check until it is seen or the person continues', () => {
    const checking = run([{ type: 'start', policy: 'require' }])
    expect(mayReleaseNow('require', checking)).toBe(false)
    expect(mayReleaseNow('require', run([{ type: 'result', result: { status: 'not-seen' } }], checking))).toBe(false)
    expect(mayReleaseNow('require', run([{ type: 'result', result: { status: 'seen', evidence } }], checking))).toBe(
      true,
    )
    expect(mayReleaseNow('require', run([{ type: 'continue' }], checking))).toBe(true)
  })
})
