import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { useState } from 'react'
import { View } from 'react-native'
import { Button } from '../../components/button'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { TextField } from '../../components/text-field'
import { QrCode } from '../qr/qr-code'

import { encodePayLink } from './pay-link'

/** Receive → Far away: the pay link, offered only while the wallet's USDC token account exists. */
export function FarAwayReceive({
  wallet,
  mint,
  tokenAccount,
  busy = false,
  onShare,
  onCreate,
}: {
  wallet: Uint8Array
  mint: Uint8Array
  tokenAccount: 'exists' | 'missing' | 'checking'
  busy?: boolean
  onShare?: (text: string) => void
  onCreate?: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const [name, setName] = useState('')
  const link = tokenAccount === 'exists' ? encodePayLink({ wallet, mint, name }) : undefined
  return (
    <Screen testID="far-away-receive">
      {tokenAccount === 'checking' ? (
        <Stage hero={<Hero kind="waiting" decorative />} title={t('remote:checking')} />
      ) : null}
      {tokenAccount === 'missing' ? (
        <>
          <Stage hero={<Hero kind="problem" decorative />} title={t('remote:needsAccount')} />
          <Button variant="filled" label={t('remote:createAccount')} busy={busy} onPress={() => onCreate?.()} />
        </>
      ) : null}
      {link ? (
        <View className="items-center gap-4">
          <Stage hero={<Hero kind="wallet" decorative size={110} />} title={t('remote:receiveTitle')}>
            <Info title={t('remote:receiveTitle')} lines={[t('remote:receiveIntro')]} />
          </Stage>
          <View className="w-full">
            <TextField label={t('remote:name')} value={name} onChangeText={setName} />
          </View>
          <QrCode text={link} accessibilityLabel={t('remote:linkLabel')} />
          <View className="w-full">
            <Button variant="filled" label={t('remote:share')} onPress={() => onShare?.(link)} />
          </View>
        </View>
      ) : null}
    </Screen>
  )
}
