import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { formatMoney } from '../../utils/format-amount'
import { copy, text } from '../payment/copy'
import type { UnfinishedView } from './unfinished'

/** The Pay tab: what can be paid without internet, the way to scan a request, and what was left unfinished. */
export function PayTab({
  ready,
  allowance,
  symbol,
  decimals,
  unfinished,
  onSetup,
  onScan,
  onPaste,
  onAddMoney,
  onResume,
  onDiscard,
}: {
  ready: boolean
  allowance: bigint
  symbol: string
  decimals: number
  unfinished: readonly UnfinishedView[]
  onSetup: () => void
  onScan: () => void
  onPaste: () => void
  onAddMoney: () => void
  onResume: (messageId: Uint8Array) => void
  onDiscard: (messageId: Uint8Array) => void
}) {
  const [discarding, setDiscarding] = useState<string>()
  return (
    <Screen testID="pay">
      <AppText variant="headline">{copy.pay.title}</AppText>
      {!ready ? (
        <View className="gap-4">
          <AppText variant="body">{copy.pay.setup}</AppText>
          <Button testID="setup-payments" variant="filled" label={copy.pay.setupAction} onPress={onSetup} />
        </View>
      ) : (
        <>
          <View className="gap-3">
            {allowance > 0n ? (
              <AppText testID="pay-allowance" variant="body">
                {text(copy.pay.allowance, { amount: formatMoney(allowance, decimals), symbol })}
              </AppText>
            ) : (
              <>
                <AppText testID="pay-allowance" variant="body">
                  {copy.pay.noAllowance}
                </AppText>
                <Button testID="add-money" variant="tonal" label={copy.pay.addMoney} onPress={onAddMoney} />
              </>
            )}
          </View>
          <View className="gap-3">
            <Button testID="pay-scan" variant="filled" label={copy.pay.scan} onPress={onScan} />
            <Button testID="pay-paste" variant="text" label={copy.pay.paste} onPress={onPaste} />
          </View>
          {unfinished.length > 0 ? (
            <View testID="pay-unfinished" className="gap-3">
              {unfinished.map((row) => {
                const id = Array.from(row.messageId, (b) => b.toString(16).padStart(2, '0')).join('')
                return (
                  <View key={id} className="gap-3 rounded-3xl bg-surface p-5">
                    <AppText variant="body">
                      {text(copy.pay.unfinished, {
                        amount: formatMoney(row.amount, decimals),
                        symbol,
                        code: row.code,
                      })}
                    </AppText>
                    {row.signed ? (
                      <AppText variant="body" tone="muted">
                        {copy.pay.notConfirmed}
                      </AppText>
                    ) : null}
                    {discarding === id ? (
                      <>
                        <AppText variant="body" tone="danger">
                          {copy.pay.discardWarning}
                        </AppText>
                        <Button
                          testID="pay-discard-confirm"
                          variant="tonal"
                          label={copy.pay.discard}
                          onPress={() => {
                            setDiscarding(undefined)
                            onDiscard(row.messageId)
                          }}
                        />
                      </>
                    ) : (
                      <View className="flex-row gap-3">
                        <Button
                          testID="pay-resume"
                          variant="filled"
                          label={row.signed ? copy.pay.showAgain : copy.pay.resume}
                          onPress={() => onResume(row.messageId)}
                        />
                        <Button
                          testID="pay-discard"
                          variant="text"
                          label={copy.pay.discard}
                          onPress={() => setDiscarding(id)}
                        />
                      </View>
                    )}
                  </View>
                )
              })}
            </View>
          ) : null}
        </>
      )}
    </Screen>
  )
}
