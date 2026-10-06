import { act } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { qrMatrix } from '../../transport/qr/matrix'
import { qrPath } from '../../transport/qr/path'
import { QrCode } from './qr-code'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('react-native-svg', () => ({ default: 'Svg', Svg: 'Svg', Path: 'Path', Rect: 'Rect' }))
vi.mock('uniwind', () => ({ useCSSVariable: () => '#000000' }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const text = 'BP:' + 'A'.repeat(300)

async function render(width?: number) {
  const renderer = await act(async () => create(<QrCode text={text} accessibilityLabel="Payment code" />))
  const root = renderer.root
  if (width !== undefined) {
    await act(async () =>
      root.findByProps({ accessibilityRole: 'image' }).props.onLayout({ nativeEvent: { layout: { width } } }),
    )
  }
  return root
}

describe('QrCode', () => {
  it('draws one path with exactly the modules of the text', async () => {
    const root = await render(1000)
    expect(root.findByType('Path' as never).props.d).toBe(qrPath(qrMatrix(text)))
  })

  it('uses whole pixels per module for the measured width', async () => {
    const modules = qrMatrix(text).length
    const root = await render(1000)
    const size = root.findByType('Svg' as never).props.width
    expect(size).toBe(Math.floor(1000 / (modules + 8)) * (modules + 8))
  })

  it('is black on white whatever the theme', async () => {
    const root = await render(1000)
    expect(root.findByType('Path' as never).props.fill).toBe('#000000')
    expect(root.findByType('Rect' as never).props.fill).toBe('#ffffff')
  })

  it('labels the code for screen readers', async () => {
    const root = await render(1000)
    const image = root.findByProps({ accessibilityRole: 'image' })
    expect(image.props.accessibilityLabel).toBe('Payment code')
  })

  it('says so when the screen is too small for a crisp code', async () => {
    const root = await render(200)
    const messages = root.findAllByType('Text' as never).flatMap((node) => node.props.children)
    expect(messages).toContain(
      'This screen is too small to show the code sharply. Try the other transport or paste the code.',
    )
  })
})
