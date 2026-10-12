import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { NAMESPACES, setLanguage } from '../../i18n'
import { LanguageSetting } from './language-setting'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))
vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
const device = vi.hoisted(() => ({ tags: ['es-CO'] as string[] }))
vi.mock('expo-localization', () => ({ getLocales: () => device.tags.map((languageTag) => ({ languageTag })) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const render = async (element: React.ReactElement) => (await act(async () => create(element))).root
const option = (root: ReactTestInstance, id: string) => root.findAllByProps({ testID: `language-option-${id}` })[0]
const press = (root: ReactTestInstance, id: string) => act(async () => void (await option(root, id).props.onPress()))

function Probe() {
  const { t } = useTranslation(NAMESPACES)
  return <Text>{t('common:duration.minute', { count: 10 })}</Text>
}

beforeEach(async () => {
  resetAsyncStorage()
  device.tags = ['es-CO']
  await setLanguage('en')
})

describe('the language setting', () => {
  it('offers the phone language and each language by its own name, whatever language is active', async () => {
    const root = await render(<LanguageSetting />)
    const shown = texts(root).join('\n')
    for (const name of ['English', 'Español', 'Português']) expect(shown).toContain(name)
    await setLanguage('pt')
    await act(async () => {})
    expect(texts(root).join('\n')).toMatch(/English[\s\S]*Español[\s\S]*Português/)
  })

  it('shows which language the phone option would use', async () => {
    const root = await render(<LanguageSetting />)
    expect(texts(root)).toContain('Phone language')
    expect(texts(root).filter((text) => text === 'Español')).toHaveLength(2)
  })

  it('marks the language in use, and the phone option when nothing was chosen', async () => {
    await setLanguage(null)
    const root = await render(<LanguageSetting />)
    expect(option(root, 'system').props.accessibilityState).toMatchObject({ selected: true })
    await press(root, 'pt')
    expect(option(root, 'pt').props.accessibilityState).toMatchObject({ selected: true })
    expect(option(root, 'system').props.accessibilityState).toMatchObject({ selected: false })
  })

  it('repaints a screen that is already open when the language changes, with no restart', async () => {
    const root = await render(
      <>
        <Probe />
        <LanguageSetting />
      </>,
    )
    expect(texts(root)).toContain('10 minutes')
    await press(root, 'es')
    expect(texts(root)).toContain('10 minutos')
    await press(root, 'pt')
    expect(texts(root)).toContain('10 minutos')
    await press(root, 'en')
    expect(texts(root)).toContain('10 minutes')
  })

  it('keeps the choice, and the phone option forgets it and follows the phone again', async () => {
    const root = await render(<LanguageSetting />)
    await press(root, 'pt')
    expect(JSON.parse((await AsyncStorage.getItem('language:v1')) ?? 'null')).toBe('pt')
    device.tags = ['es-419']
    await press(root, 'system')
    expect(await AsyncStorage.getItem('language:v1')).toBeNull()
    expect(texts(await render(<Probe />))).toContain('10 minutos')
  })
})
