import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking } from 'react-native'
import { countFlagged } from '../../features/mesh/gossip'
import { syncRelay } from '../../features/mesh/headless'
import { meshNative } from '../../features/mesh/native'
import { useMesh } from '../../features/mesh/use-mesh'
import { Settings } from '../../features/settings/settings'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { useTipTerms } from '../../features/rewards/seams'
import { useTipping } from '../../features/rewards/use-tipping'
import { carried } from '../../features/relay/inbox'
import { usePrivateData } from '../../features/zk/use-private-data'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { usePayments } from '../../features/payment/payments-provider'
import { formatMoney, parseAmount } from '../../utils/format-amount'
import { formatDuration } from '../../utils/format-duration'

const money = (units: bigint) => `${formatMoney(units, BUILD_TOKEN.decimals)} ${BUILD_TOKEN.symbol}`

export default function SettingsTab() {
  const { unsettled } = useSettlementRunner()
  const { db, witnessSettings, setWitnessSettings } = usePayments()
  const [warnings, setWarnings] = useState(0)
  const [passedOn, setPassedOn] = useState(0)
  useEffect(() => {
    if (db) void countFlagged(db).then(setWarnings)
    if (db) void carried(db).then(setPassedOn)
  }, [db])
  const mesh = useMesh(meshNative)
  const privateData = usePrivateData()
  const tipping = useTipping(useTipTerms())
  useEffect(() => {
    if (mesh.enabled) void syncRelay()
  }, [mesh.enabled])
  const [requireFrom, setRequireFrom] = useState(
    witnessSettings.requireFrom === null ? '' : formatMoney(witnessSettings.requireFrom, BUILD_TOKEN.decimals),
  )
  return (
    <Settings
      privateData={privateData}
      tipping={tipping.settings}
      mesh={{
        enabled: mesh.enabled,
        problem: mesh.problem,
        warnings,
        passedOn,
        onToggle: (on) => void mesh.setEnabled(on),
        onOpenSettings: () => void Linking.openSettings(),
      }}
      payments={{
        unsettled: unsettled?.count ?? 0,
        limits: {
          perPayment: money(PAY_LIMITS.maxPayment),
          biometricFrom: money(PAY_LIMITS.biometricFrom),
          biometricDaily: money(PAY_LIMITS.biometricDaily),
          window: formatDuration(MIN_WINDOW),
        },
        onReset: () => router.push('/reset-identity'),
        onEvents: () => router.push('/events'),
        nearbyCheck: {
          answer: witnessSettings.answer,
          ask: witnessSettings.ask,
          audible: witnessSettings.audible,
          requireFrom,
          onAnswer: (answer) => setWitnessSettings({ answer }),
          onAsk: (ask) => setWitnessSettings({ ask }),
          onAudible: (audible) => setWitnessSettings({ audible }),
          onRequireFrom: (value) => {
            setRequireFrom(value)
            const amount = parseAmount(value, BUILD_TOKEN.decimals)
            if (value.trim() === '') setWitnessSettings({ requireFrom: null })
            else if (amount !== undefined && amount > 0n) setWitnessSettings({ requireFrom: amount })
          },
        },
      }}
    />
  )
}
