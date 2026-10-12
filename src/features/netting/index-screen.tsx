import { useTranslation } from 'react-i18next'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { NAMESPACES } from '../../i18n'
import type { SessionView } from './session-view'

export type RecentSession = { id: string; view: SessionView }

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
      <AppText variant="headline">{t('netting:index.title')}</AppText>
      <AppText variant="body">{t('netting:index.intro')}</AppText>
      <AppText variant="body" tone="muted">
        {t('netting:index.what')}
      </AppText>
      <View className="gap-3">
        <Button testID="netting-host" variant="filled" label={t('netting:index.host')} onPress={onHost} />
        <Button testID="netting-join" variant="tonal" label={t('netting:index.join')} onPress={onJoin} />
      </View>
      <AppText variant="title">{t('netting:index.recent')}</AppText>
      {recent.length === 0 ? (
        <AppText variant="body" tone="muted">
          {t('netting:index.none')}
        </AppText>
      ) : null}
      {recent.map(({ id, view }) => (
        <Pressable
          key={id}
          testID={`netting-session-${id}`}
          accessibilityRole="button"
          accessibilityLabel={`${view.headline}. ${view.body}`}
          onPress={() => onOpen(id)}
          className="min-h-14 justify-center py-2"
        >
          <AppText variant="body" tone={view.tone}>
            {view.headline}
          </AppText>
          <AppText variant="label" tone="muted">
            {view.body}
          </AppText>
        </Pressable>
      ))}
    </Screen>
  )
}
