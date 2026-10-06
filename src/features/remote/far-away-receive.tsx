import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { TextField } from '../../components/text-field'
import { QrCode } from '../qr/qr-code'
import { remoteCopy } from './copy'
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
  const [name, setName] = useState('')
  const link = tokenAccount === 'exists' ? encodePayLink({ wallet, mint, name }) : undefined
  return (
    <Screen testID="far-away-receive">
      <AppText variant="headline">{remoteCopy.receiveTitle}</AppText>
      {tokenAccount === 'checking' ? <AppText variant="body">{remoteCopy.checking}</AppText> : null}
      {tokenAccount === 'missing' ? (
        <View className="gap-3">
          <AppText variant="body">{remoteCopy.needsAccount}</AppText>
          <Button variant="filled" label={remoteCopy.createAccount} busy={busy} onPress={() => onCreate?.()} />
        </View>
      ) : null}
      {link ? (
        <View className="gap-3">
          <AppText variant="body">{remoteCopy.receiveIntro}</AppText>
          <TextField label={remoteCopy.name} value={name} onChangeText={setName} />
          <QrCode text={link} accessibilityLabel={remoteCopy.linkLabel} />
          <Button variant="filled" label={remoteCopy.share} onPress={() => onShare?.(link)} />
        </View>
      ) : null}
    </Screen>
  )
}
