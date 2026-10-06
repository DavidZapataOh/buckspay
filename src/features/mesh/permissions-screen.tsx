import { useState } from 'react'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { meshCopy } from './copy'
import type { PermissionGroup } from './native'

export type PermissionsScreenProps = {
  request: (groups: readonly PermissionGroup[]) => Promise<'granted' | 'denied'>
  onDone: (result: { mesh: boolean }) => void
}

/** Says what Buckspay asks for and why, asks once, and continues whatever the answer. */
export function PermissionsScreen({ request, onDone }: PermissionsScreenProps) {
  const [answer, setAnswer] = useState<'granted' | 'denied'>()
  const [busy, setBusy] = useState(false)

  async function allow() {
    setBusy(true)
    setAnswer(await request(['nearby', 'notifications']))
    setBusy(false)
  }

  return (
    <Screen testID="permissions">
      <AppText variant="headline" accessibilityRole="header">
        {meshCopy.title}
      </AppText>
      <AppText variant="body">{meshCopy.body}</AppText>
      {answer ? (
        <Button variant="filled" label={meshCopy.continue} onPress={() => onDone({ mesh: answer === 'granted' })} />
      ) : (
        <Button variant="filled" label={meshCopy.allow} busy={busy} onPress={() => void allow()} />
      )}
      <AppText variant="body">{meshCopy.footnote}</AppText>
    </Screen>
  )
}
