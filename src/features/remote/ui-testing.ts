import { act, type ReactElement } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

export const mount = async (element: ReactElement) => act(async () => create(element))

export const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))

/** The host element a screen reader would announce as `label`. */
export const byLabel = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.props.accessibilityLabel === label && typeof node.type === 'string')[0]

export const press = (root: ReactTestInstance, label: string) => act(async () => byLabel(root, label).props.onPress())

export const type = (root: ReactTestInstance, label: string, value: string) =>
  act(async () => byLabel(root, label).props.onChangeText(value))
