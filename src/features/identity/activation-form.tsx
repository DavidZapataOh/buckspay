import { useTranslation } from 'react-i18next'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatAmount, formatDate, formatMoney, parseAmount } from '../../i18n/format'
import { useState } from 'react'
import { View } from 'react-native'
import type { Windows } from '../../protocol'
import { AmountField } from '../../components/amount-field'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { TextField } from '../../components/text-field'
import { FaucetOffer } from '../lock/faucet-offer'
import type { FaucetGateway } from '../lock/gateway'

import { FUNDING_SYMBOL, feeNotice, minimumNotice, networkCostNotice, withdrawalDateNotice } from '../lock/lock-copy'
import { formatSol } from '../../utils/format-sol'
import { type Activation, type ActivationInput, isSponsored, lockUntil } from './activation'
import { shortfallNotice } from './identity-copy'
import type { Sponsorship } from './device-identity'

/**
 * The "Add funds" step: how much to lock and for how long, with what it costs, who pays the network
 * and when the funds can be taken back, all shown before the wallet is asked for anything: as chips, with
 * the full sentences one tap away.
 */
export function ActivationForm({
  activation,
  sponsorship,
  windows,
  busy,
  action,
  faucet,
  onSubmit,
}: {
  activation: Activation
  sponsorship?: Sponsorship
  windows: Windows
  busy: boolean
  action: string
  /** Test money for a wallet that has too little, on a gateway that runs a faucet. */
  faucet?: { wallet: string; gateway: FaucetGateway | undefined; read: () => Promise<bigint> }
  onSubmit: (input: ActivationInput) => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const { funding, quote, sol } = activation
  const [amountText, setAmountText] = useState(formatAmount(activation.defaultAmount, funding.decimals))
  const [daysText, setDaysText] = useState(String(activation.defaultLockDays))
  const [balance, setBalance] = useState(funding.balance)
  const amount = parseAmount(amountText, funding.decimals)
  const lockDays = /^\d+$/.test(daysText) ? Number(daysText) : undefined
  const input = amount !== undefined && lockDays !== undefined ? { amount, lockDays } : undefined
  const sponsored = input ? isSponsored(activation, sponsorship, input) : sponsorship === 'free'
  const belowMinimum =
    sponsorship === 'free' && quote !== undefined && amount !== undefined && amount < quote.minFunding
  const shortfall = shortfallNotice(activation, sponsored)
  const fee = sponsored && quote ? quote.fee : 0n
  const sentences = [
    feeNotice(fee, funding.decimals),
    networkCostNotice(sponsored, sol.cost),
    ...(lockDays !== undefined ? [withdrawalDateNotice(lockUntil(lockDays), windows)] : []),
    ...(sponsorship === 'free' && quote ? [minimumNotice(quote.minFunding, funding.decimals)] : []),
  ]

  return (
    <View testID="activation-form" className="gap-4">
      <View testID="funding-balance" className="items-center">
        <Chip
          center
          kind="info"
          icon="account_balance_wallet"
          label={t('identity:walletHasShort', {
            amount: formatMoney(balance, funding.decimals, currentLanguage()),
            symbol: FUNDING_SYMBOL,
          })}
        />
      </View>
      {faucet ? (
        <FaucetOffer
          wallet={faucet.wallet}
          balance={balance}
          needed={amount ?? activation.defaultAmount}
          symbol={FUNDING_SYMBOL}
          decimals={funding.decimals}
          gateway={faucet.gateway}
          read={faucet.read}
          onClaimed={setBalance}
        />
      ) : null}
      <AmountField
        testID="funding-amount"
        label={t('identity:amountToAdd', { symbol: FUNDING_SYMBOL })}
        symbol={FUNDING_SYMBOL}
        value={amountText}
        onChangeText={setAmountText}
      />
      {sponsorship === 'free' && quote && belowMinimum ? (
        <View testID="funding-minimum" className="items-center">
          <Chip
            center
            kind="waiting"
            label={t('identity:minShort', {
              amount: formatMoney(quote.minFunding, funding.decimals, currentLanguage()),
              symbol: FUNDING_SYMBOL,
            })}
          />
        </View>
      ) : null}
      <TextField
        testID="lock-days"
        label={t('identity:lockLengthDays')}
        value={daysText}
        onChangeText={setDaysText}
        keyboardType="numeric"
      />
      <View className="flex-row flex-wrap items-center justify-center gap-2">
        <View testID="funding-fee">
          <Chip
            center
            kind="info"
            icon="payments"
            label={
              fee > 0n
                ? t('identity:feeShort', {
                    amount: formatMoney(fee, funding.decimals, currentLanguage()),
                    symbol: FUNDING_SYMBOL,
                  })
                : t('identity:noFee')
            }
          />
        </View>
        <View testID="network-cost">
          <Chip
            center
            kind="info"
            icon="bolt"
            label={
              sponsored ? t('identity:networkPaid') : t('identity:networkWallet', { sol: formatSol(sol.cost, 'up') })
            }
          />
        </View>
        {lockDays !== undefined ? (
          <View testID="withdrawal-date">
            <Chip
              center
              kind="info"
              icon="event"
              label={t('identity:takeBackFrom', {
                date: formatDate(lockUntil(lockDays) + windows.claimWindow, currentLanguage(), 'UTC'),
              })}
            />
          </View>
        ) : null}
        <Info title={action} lines={sentences} />
      </View>
      {shortfall ? (
        <View testID="sol-shortfall" className="items-center">
          <Chip center kind="problem" label={shortfall} />
        </View>
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
