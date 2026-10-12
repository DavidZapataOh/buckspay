import { View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AppText } from '../../components/app-text'
import { Segmented } from '../../components/segmented'
import { deviceLanguage, NAMESPACES } from '../../i18n'
import { LANGUAGE_NAMES, LANGUAGES, type Language } from '../../i18n/languages'
import { useLanguage } from '../../i18n/use-language'

/** The language of the app: one of its own, or the phone's. Each language is named in its own words. */
export function LanguageSetting() {
  const { t } = useTranslation(NAMESPACES)
  const { choice, choose } = useLanguage()
  const value = choice ?? 'system'
  return (
    <View>
      <AppText variant="title" accessibilityRole="header">
        {t('settings:language.title')}
      </AppText>
      <Segmented
        value={value}
        onChange={(id) => void choose(id === 'system' ? null : (id as Language))}
        options={[
          { id: 'system', label: t('settings:language.system'), icon: 'smartphone', testID: 'language-option-system' },
          ...LANGUAGES.map((language: Language) => ({
            id: language,
            label: LANGUAGE_NAMES[language],
            testID: `language-option-${language}`,
          })),
        ]}
      />
      <AppText variant="label" tone="muted">
        {LANGUAGE_NAMES[deviceLanguage()]}
      </AppText>
    </View>
  )
}
