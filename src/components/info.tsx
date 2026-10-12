import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Pressable, View } from 'react-native'
import { NAMESPACES } from '../i18n'
import { AppText } from './app-text'
import { Button } from './button'
import { IconButton } from './icon-button'

/** Where the long text goes: a small button on the screen, and the explanation in a sheet only when it is asked for. */
export function Info({ title, lines }: { title: string; lines: readonly string[] }) {
  const { t } = useTranslation(NAMESPACES)
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton icon="info" label={t('common:moreInfo')} onPress={() => setOpen(true)} />
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common:close')}
          onPress={() => setOpen(false)}
          className="min-h-12 flex-1 justify-end bg-black/50"
        >
          <View className="gap-3 rounded-t-3xl bg-surface p-6" onStartShouldSetResponder={() => true}>
            <AppText variant="headline">{title}</AppText>
            {lines.map((line) => (
              <AppText key={line} variant="body" tone="muted">
                {line}
              </AppText>
            ))}
            <Button variant="tonal" label={t('common:close')} onPress={() => setOpen(false)} />
          </View>
        </Pressable>
      </Modal>
    </>
  )
}
