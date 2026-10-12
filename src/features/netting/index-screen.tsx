import { useTranslation } from 'react-i18next'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Tile } from '../../components/tile'
import { NAMESPACES } from '../../i18n'
import { heroOf, type SessionView } from './session-view'

export type RecentSession = { id: string; view: SessionView }

const KIND = { done: 'done', problem: 'problem', waiting: 'waiting', nearby: 'waiting' } as const

export function IndexScreen({
  recent,
  onHost,
  onJoin,
  onOpen,
}: {
  recent: readonly RecentSession[]
  onHost: () => void
  onJoin: () => void
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation(NAMESPACES)
  return (
    <Screen testID="netting-index">
      <View className="flex-row items-center justify-between">
        <AppText variant="headline">{t('netting:index.title')}</AppText>
        <Info title={t('netting:index.title')} lines={[t('netting:index.intro'), t('netting:index.what')]} />
      </View>
      <View className="items-center">
        <Hero kind="coins" decorative size={130} />
      </View>
      <View className="flex-row gap-3">
        <Tile testID="netting-host" highlight icon="group_add" title={t('netting:index.host')} onPress={onHost} />
        <Tile testID="netting-join" icon="qr_code_scanner" title={t('netting:index.join')} onPress={onJoin} />
      </View>
      {recent.length > 0 ? <AppText variant="title">{t('netting:index.recent')}</AppText> : null}
      {recent.map(({ id, view }) => (
        <Pressable
          key={id}
          testID={`netting-session-${id}`}
          accessibilityRole="button"
          accessibilityLabel={`${view.headline}. ${view.body}`}
          onPress={() => onOpen(id)}
          className="min-h-16 gap-1 rounded-3xl border border-outline bg-surface p-4 active:bg-secondary-container"
        >
          <AppText variant="title">{view.headline}</AppText>
          <Chip kind={KIND[heroOf(view)]} label={view.line || view.headline} />
        </Pressable>
      ))}
    </Screen>
  )
}
