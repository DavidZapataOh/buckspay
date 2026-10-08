import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { act } from 'react'
import { create } from 'react-test-renderer'
import { AppState } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLoopbackPair } from '../../transport/testing/loopback'
import type { TransportEntry } from './registry'
import { showHow, useTransportChoice, useTransports, type Offered } from './use-transports'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const entry = (id: 'qr' | 'nfc' | 'nearby', ready = true): TransportEntry => ({
  id,
  label: id,
  check: async () => (ready ? { ready: true } : { ready: false, reason: 'disabled' }),
  start: async () => createLoopbackPair()[0],
})

beforeEach(resetAsyncStorage)

async function probe<T>(use: () => T) {
  const seen: { current: T } = {} as { current: T }
  function Probe() {
    seen.current = use()
    return null
  }
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(<Probe />)
  })
  return {
    seen,
    renderer,
    rerender: (use2: () => T) => act(async () => renderer.update(<Reprobe use={use2} seen={seen} />)),
  }
}
function Reprobe<T>({ use, seen }: { use: () => T; seen: { current: T } }) {
  seen.current = use()
  return null
}

describe('the How control appears only with a choice', () => {
  it('hides with one ready medium and shows with two', () => {
    const offered = (flags: boolean[]): Offered[] =>
      flags.map((ready, i) => ({
        entry: entry((['qr', 'nfc', 'nearby'] as const)[i], ready),
        availability: ready ? { ready: true } : { ready: false, reason: 'disabled' },
      }))
    expect(showHow(offered([true, false, false]))).toBe(true)
    expect(showHow(offered([true, true, false]))).toBe(true)
  })

  it('stays hidden when the other media are not available on this phone', () => {
    const unsupported: Offered[] = [
      { entry: entry('qr'), availability: { ready: true } },
      { entry: entry('nearby', false), availability: { ready: false, reason: 'unsupported' } },
    ]
    expect(showHow(unsupported)).toBe(false)
  })
})

describe('useTransports', () => {
  it('asks again when the app returns to the foreground, so a fixed setting turns the medium ready', async () => {
    let bluetooth = false
    const nearby: TransportEntry = {
      ...entry('nearby'),
      check: async () => (bluetooth ? { ready: true } : { ready: false, reason: 'disabled' }),
    }
    const entries = [entry('qr'), nearby]
    let onChange: (status: string) => void = () => {}
    vi.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, handler: (status: string) => void) => {
      onChange = handler
      return { remove: () => {} }
    }) as never)
    const { seen } = await probe(() => useTransports(entries))
    expect(seen.current.ready.map((e) => e.id)).toEqual(['qr'])
    bluetooth = true
    await act(async () => onChange('active'))
    expect(seen.current.ready.map((e) => e.id)).toEqual(['qr', 'nearby'])
  })

  it('asks every entry and lists the ready ones', async () => {
    const entries = [entry('qr'), entry('nfc', false), entry('nearby')]
    const { seen } = await probe(() => useTransports(entries))
    expect(seen.current.ready.map((e) => e.id)).toEqual(['qr', 'nearby'])
    expect(seen.current.offered.map((o) => o.availability.ready)).toEqual([true, false, true])
  })
})

describe('the remembered choice', () => {
  it('defaults to QR, remembers per role, and falls back to QR when the remembered one is not ready', async () => {
    const both = [entry('qr'), entry('nfc')]
    const payer = await probe(() => useTransportChoice('payer', both))
    expect(payer.seen.current.chosen.id).toBe('qr')
    await act(async () => payer.seen.current.choose('nfc'))
    expect(payer.seen.current.chosen.id).toBe('nfc')
    expect(await AsyncStorage.getItem('how.payer')).toBe('nfc')
    await payer.rerender(() => useTransportChoice('payer', [entry('qr')]))
    expect(payer.seen.current.chosen.id).toBe('qr')
    const receiver = await probe(() => useTransportChoice('receiver', both))
    expect(receiver.seen.current.chosen.id).toBe('qr')
  })

  it('opens on the medium the role used last', async () => {
    await AsyncStorage.setItem('how.receiver', 'nearby')
    const list = [entry('qr'), entry('nearby')]
    const { seen } = await probe(() => useTransportChoice('receiver', list))
    expect(seen.current.chosen.id).toBe('nearby')
  })
})
