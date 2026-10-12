import { useTranslation } from 'react-i18next'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { useFeedbackPreferences } from '../../feedback/use-feedback'
import { NAMESPACES } from '../../i18n'

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <View className="min-h-14 flex-row items-center justify-between gap-4">
      <AppText variant="body">{label}</AppText>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} />
    </View>
  )
}

/** Whether the app answers with sound and with vibration. Both start on. */
export function FeedbackSetting() {
  const { t } = useTranslation(NAMESPACES)
  const { prefs, choose } = useFeedbackPreferences()
  return (
    <View>
      <Row
        label={t('settings:feedback.sound')}
        value={prefs.sound}
        onChange={(sound) => void choose({ ...prefs, sound })}
      />
      <Row
        label={t('settings:feedback.haptics')}
        value={prefs.haptics}
        onChange={(haptics) => void choose({ ...prefs, haptics })}
      />
    </View>
  )
}
