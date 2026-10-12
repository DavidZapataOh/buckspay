import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { useState } from 'react'
import { Button } from '../../components/button'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'

import type { PermissionGroup } from './native'

export type PermissionsScreenProps = {
  request: (groups: readonly PermissionGroup[]) => Promise<'granted' | 'denied'>
  onDone: (result: { mesh: boolean }) => void
}

/** Says what Buckspay asks for in a picture and a few words, asks once, and continues whatever the answer. */
export function PermissionsScreen({ request, onDone }: PermissionsScreenProps) {
  const { t } = useTranslation(NAMESPACES)

  const [answer, setAnswer] = useState<'granted' | 'denied'>()
  const [busy, setBusy] = useState(false)

  async function allow() {
    setBusy(true)
    setAnswer(await request(['nearby', 'notifications']))
    setBusy(false)
  }

  return (
    <Screen
      testID="permissions"
      footer={
        answer ? (
          <Button variant="filled" label={t('mesh:continue')} onPress={() => onDone({ mesh: answer === 'granted' })} />
        ) : (
          <Button variant="filled" label={t('mesh:allow')} busy={busy} onPress={() => void allow()} />
        )
      }
    >
      <Stage hero={<Hero kind="nearby" decorative size={180} />} title={t('mesh:title')} line={t('mesh:line')}>
        <Info title={t('mesh:title')} lines={[t('mesh:body'), t('mesh:footnote')]} />
      </Stage>
    </Screen>
  )
}
