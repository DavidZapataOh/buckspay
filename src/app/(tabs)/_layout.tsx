import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { useThemeColors } from '../../theme/use-theme-colors'

export default function TabsLayout() {
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
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
