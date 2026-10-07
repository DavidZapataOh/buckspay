import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { loadTipping, saveTipping } from './tip-setting'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

beforeEach(resetAsyncStorage)

describe('tip setting', () => {
  it('is on until the person turns it off, and remembers either choice', async () => {
    expect(await loadTipping()).toBe(true)
    await saveTipping(false)
    expect(await loadTipping()).toBe(false)
    await saveTipping(true)
    expect(await loadTipping()).toBe(true)
  })
  it('falls back to the default for a value it does not know', async () => {
    await AsyncStorage.setItem('tip-setting:v1', 'maybe')
    expect(await loadTipping()).toBe(true)
  })
})
