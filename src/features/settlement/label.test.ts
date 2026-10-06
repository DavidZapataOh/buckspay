import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage, storedItems } from '../../test-support/async-storage'
import { acknowledgeLabel, isLabelAcknowledged } from './label'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

beforeEach(() => resetAsyncStorage())

describe('the label before settling in the clear', () => {
  it('is not acknowledged until the person continues, and then stays so', async () => {
    expect(await isLabelAcknowledged()).toBe(false)
    await acknowledgeLabel()
    expect(await isLabelAcknowledged()).toBe(true)
    expect(Object.keys(storedItems())).toEqual(['settlement:label-v1'])
  })

  it('is not acknowledged by anything else stored under its name', async () => {
    await AsyncStorage.setItem('settlement:label-v1', 'maybe')
    expect(await isLabelAcknowledged()).toBe(false)
  })
})
