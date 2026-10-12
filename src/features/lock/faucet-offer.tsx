import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { Tile } from '../../components/tile'
import { feedback } from '../../feedback'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatDuration, formatMoney } from '../../i18n/format'
import { type FaucetGateway, GatewayError } from './gateway'

type Result = { kind: 'done'; amount: bigint } | { kind: 'later'; seconds: number } | { kind: 'failed' }

/**
 * Free test money for a wallet that has less than it needs, on a test network whose gateway runs a
 * faucet. It appears only then, and says plainly that the money has no value.
 */
export function FaucetOffer({
  wallet,
  balance,
  needed,
  symbol,
  decimals,
  gateway,
  read,
  onClaimed,
}: {
  wallet: string
  balance: bigint
  needed: bigint
  symbol: string
  decimals: number
  gateway: FaucetGateway | undefined
  /** What the wallet holds now, read from the cluster. */
  read: () => Promise<bigint>
  onClaimed: (balance: bigint) => void
}) {
  const { t } = useTranslation(NAMESPACES)
  const [amount, setAmount] = useState<bigint>()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result>()
  const short = balance < needed

  useEffect(() => {
    if (!short || !gateway) return
    let current = true
    gateway.faucetOffer().then(
      (offer) => current && setAmount(offer?.amount),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [gateway, short])

  const offering = short && amount !== undefined && gateway !== undefined
  if (!offering && result?.kind !== 'done') return null

  const money = (units: bigint) => `${formatMoney(units, decimals, currentLanguage())} ${symbol}`
  function added(units: bigint) {
    return t('identity:faucet.done', { amount: money(units) })
  }

  async function claim() {
    if (!gateway) return
    setBusy(true)
    setResult(undefined)
    try {
      const claimed = await gateway.faucetClaim(wallet)
      setResult({ kind: 'done', amount: claimed.amount })
      feedback.cue('success')
      onClaimed(await read())
    } catch (error) {
      feedback.cue('problem')
      const seconds = error instanceof GatewayError && error.status === 429 ? error.body.retryAfter : undefined
      setResult(typeof seconds === 'number' ? { kind: 'later', seconds } : { kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="gap-3" testID="faucet-offer">
      {offering ? (
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Tile
              testID="faucet-get"
              highlight
              icon="redeem"
              title={t('identity:faucet.get')}
              hint={busy ? t('common:working') : `+${money(amount)}`}
              onPress={() => !busy && void claim()}
            />
          </View>
          <Info title={t('identity:faucet.get')} lines={[t('identity:faucet.help')]} />
        </View>
      ) : null}
      {result?.kind === 'done' ? <Chip center kind="done" label={added(result.amount)} /> : null}
      {result?.kind === 'later' ? (
        <Chip center kind="waiting" label={t('identity:faucet.later', { time: formatDuration(result.seconds) })} />
      ) : null}
      {result?.kind === 'failed' ? <Chip center kind="problem" label={t('identity:faucet.failed')} /> : null}
    </View>
  )
}
