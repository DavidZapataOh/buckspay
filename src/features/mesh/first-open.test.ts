import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAsyncStorage } from '../../test-support/async-storage'
import { hasSeenPermissions, markPermissionsSeen } from './first-open'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

beforeEach(resetAsyncStorage)

describe('the first open', () => {
  it('is a fresh install until the permission screen was answered once', async () => {
    expect(await hasSeenPermissions()).toBe(false)
    await markPermissionsSeen()
    expect(await hasSeenPermissions()).toBe(true)
  })
})
