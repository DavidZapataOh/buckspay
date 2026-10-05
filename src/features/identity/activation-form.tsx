import { useState } from 'react'
import { View } from 'react-native'
import type { Windows } from '../../protocol'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { TextField } from '../../components/text-field'
import { formatAmount, parseAmount } from '../../utils/format-amount'
import { FUNDING_SYMBOL, feeNotice, minimumNotice, networkCostNotice, withdrawalDateNotice } from '../lock/lock-copy'
import { type Activation, type ActivationInput, isSponsored, lockUntil } from './activation'
import { shortfallNotice } from './identity-copy'
import type { Sponsorship } from './device-identity'

/**
 * The "Add funds" step: how much to lock and for how long, with what it costs, who pays the network
 * and when the funds can be taken back, all shown before the wallet is asked for anything.
 */
export function ActivationForm({
  activation,
  sponsorship,
  windows,
  busy,
  action,
  onSubmit,
}: {
  activation: Activation
  sponsorship?: Sponsorship
  windows: Windows
  busy: boolean
  action: string
  onSubmit: (input: ActivationInput) => void
}) {
  const { funding, quote, sol } = activation
  const [amountText, setAmountText] = useState(formatAmount(activation.defaultAmount, funding.decimals))
  const [daysText, setDaysText] = useState(String(activation.defaultLockDays))
  const amount = parseAmount(amountText, funding.decimals)
  const lockDays = /^\d+$/.test(daysText) ? Number(daysText) : undefined
  const input = amount !== undefined && lockDays !== undefined ? { amount, lockDays } : undefined
  const sponsored = input ? isSponsored(activation, sponsorship, input) : sponsorship === 'free'
  const belowMinimum =
    sponsorship === 'free' && quote !== undefined && amount !== undefined && amount < quote.minFunding
  const shortfall = shortfallNotice(activation, sponsored)

  return (
    <View testID="activation-form" className="gap-4">
      <AppText testID="funding-balance" variant="body">
        Your wallet has {formatAmount(funding.balance, funding.decimals)} {FUNDING_SYMBOL}.
      </AppText>
      <TextField
        testID="funding-amount"
        label={`Amount to add (${FUNDING_SYMBOL})`}
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="lock-days"
        label="Lock length (days)"
        value={daysText}
        onChangeText={setDaysText}
        keyboardType="numeric"
      />
      {sponsorship === 'free' && quote ? (
        <AppText testID="funding-minimum" variant="body" tone="muted">
          {minimumNotice(quote.minFunding, funding.decimals)}
          {belowMinimum ? ' Below it, your wallet pays the network costs.' : ''}
        </AppText>
      ) : null}
      <AppText testID="funding-fee" variant="body">
        {feeNotice(sponsored && quote ? quote.fee : 0n, funding.decimals)}
      </AppText>
      <AppText testID="network-cost" variant="body">
        {networkCostNotice(sponsored, sol.cost)}
      </AppText>
      {lockDays !== undefined ? (
        <AppText testID="withdrawal-date" variant="body" tone="muted">
          {withdrawalDateNotice(lockUntil(lockDays), windows)}
        </AppText>
      ) : null}
      {shortfall ? (
        <AppText testID="sol-shortfall" variant="body" tone="danger">
          {shortfall}
        </AppText>
      ) : null}
      <Button
        testID="onboarding-next"
        variant="filled"
        label={action}
        busy={busy}
        disabled={!input}
        onPress={() => input && onSubmit(input)}
      />
    </View>
  )
}
