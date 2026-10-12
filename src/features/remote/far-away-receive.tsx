import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
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
      <AppText variant="headline">{t('remote:receiveTitle')}</AppText>
      {tokenAccount === 'checking' ? <AppText variant="body">{t('remote:checking')}</AppText> : null}
      {tokenAccount === 'missing' ? (
        <View className="gap-3">
          <AppText variant="body">{t('remote:needsAccount')}</AppText>
          <Button variant="filled" label={t('remote:createAccount')} busy={busy} onPress={() => onCreate?.()} />
        </View>
      ) : null}
      {link ? (
        <View className="gap-3">
          <AppText variant="body">{t('remote:receiveIntro')}</AppText>
          <TextField label={t('remote:name')} value={name} onChangeText={setName} />
          <QrCode text={link} accessibilityLabel={t('remote:linkLabel')} />
          <Button variant="filled" label={t('remote:share')} onPress={() => onShare?.(link)} />
        </View>
      ) : null}
    </Screen>
  )
}
