import { Pressable, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AppText } from '../../components/app-text'
import { deviceLanguage, NAMESPACES } from '../../i18n'
import { LANGUAGE_NAMES, LANGUAGES, type Language } from '../../i18n/languages'
import { useLanguage } from '../../i18n/use-language'

function Option({
  id,
  title,
  subtitle,
  selected,
  onPress,
}: {
  id: string
  title: string
  subtitle?: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      testID={`language-option-${id}`}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`min-h-14 px-4 py-2 rounded-xl justify-center ${selected ? 'bg-secondary-container' : ''}`}
    >
      <AppText variant="body">{title}</AppText>
      {subtitle ? (
        <AppText variant="label" tone="muted">
          {subtitle}
        </AppText>
      ) : null}
    </Pressable>
  )
}

/** The language of the app: one of its own, or the phone's. Each language is named in its own words. */
export function LanguageSetting() {
  const { t } = useTranslation(NAMESPACES)
  const { choice, choose } = useLanguage()
  return (
    <View accessibilityRole="radiogroup">
      <AppText variant="title" accessibilityRole="header">
        {t('settings:language.title')}
      </AppText>
      <Option
        id="system"
        title={t('settings:language.system')}
        subtitle={LANGUAGE_NAMES[deviceLanguage()]}
        selected={choice === null}
        onPress={() => void choose(null)}
      />
      {LANGUAGES.map((language: Language) => (
        <Option
          key={language}
          id={language}
          title={LANGUAGE_NAMES[language]}
          selected={choice === language}
          onPress={() => void choose(language)}
        />
      ))}
    </View>
  )
}
