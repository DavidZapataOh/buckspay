import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { useThemeColors } from '../../theme/use-theme-colors'

export default function TabsLayout() {
  const { t } = useTranslation(NAMESPACES)

  const [surface, muted, primary, indicator, selected] = useThemeColors(
    'surface',
    'muted',
    'primary',
    'secondary-container',
    'on-secondary-container',
  )
  return (
    <NativeTabs
      backgroundColor={surface}
      tintColor={primary}
      iconColor={{ default: muted, selected }}
      indicatorColor={indicator}
      labelStyle={{ default: { color: muted }, selected: { color: primary } }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t('common:tabs.home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="pay">
        <NativeTabs.Trigger.Label>{t('common:tabs.pay')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="north_east" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="receive">
        <NativeTabs.Trigger.Label>{t('common:tabs.receive')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="south_west" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Label>{t('common:tabs.activity')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="history" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>{t('common:tabs.settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
