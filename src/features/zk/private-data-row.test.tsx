import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { PrivateDataRow } from './private-data-row'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const host = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props.testID === id && typeof node.type === 'string')

describe('PrivateDataRow', () => {
  it('offers the download only while the data is missing', async () => {
    const onDownload = vi.fn()
    const missing = await act(async () =>
      create(<PrivateDataRow state="missing" progress={0} sizeBytes={0} onDownload={onDownload} />),
    )
    expect(texts(missing.root)).toContain('Not downloaded · about 282 MB')
    await act(async () => host(missing.root, 'private-data-download')[0].props.onPress())
    expect(onDownload).toHaveBeenCalledOnce()
    for (const state of ['ready', 'downloading', 'expanding', 'unavailable'] as const) {
      const renderer = await act(async () =>
        create(<PrivateDataRow state={state} progress={0.5} sizeBytes={282_000_000} onDownload={onDownload} />),
      )
      expect(host(renderer.root, 'private-data-download')).toHaveLength(0)
    }
  })

  it('says how much room the data takes and how far the download is', async () => {
    const ready = await act(async () =>
      create(<PrivateDataRow state="ready" progress={1} sizeBytes={282_400_000} onDownload={() => {}} />),
    )
    expect(texts(ready.root)).toContain('Ready · 282 MB on this phone')
    const loading = await act(async () =>
      create(<PrivateDataRow state="downloading" progress={0.42} sizeBytes={0} onDownload={() => {}} />),
    )
    expect(texts(loading.root)).toContain('Downloading · 42%')
  })
})
