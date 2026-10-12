import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { router } from 'expo-router'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { AddressRow } from '../../components/address-row'
import { Button } from '../../components/button'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Stage } from '../../components/stage'
import { Screen } from '../../components/screen'
import { HomeSummary } from '../../features/home/home-summary'
import { homeStatus } from '../../features/identity/identity-copy'
import { useDeviceIdentity } from '../../features/identity/use-device-identity'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { RotationAlert } from '../../features/lock/rotation-alert'
import { BUILD_NETWORK } from '../../features/network/build-network'
import { SettlementLabel } from '../../features/settlement/settlement-label'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'

export default function Home() {
  const { t } = useTranslation(NAMESPACES)

  const identity = useDeviceIdentity()
  const settlement = useSettlementRunner()
  const flow = usePayFlow()
  const { busy, device, next } = identity
  const status = homeStatus(identity)
  const ready = status.testID === 'device-ready'

  return (
    <Screen testID="home">
      {ready ? (
        <>
          <HomeSummary
            allowance={flow.offline.loaded ? flow.offline.allowance() : null}
            settling={settlement.unsettled?.count ?? 0}
            symbol={BUILD_TOKEN.symbol}
            decimals={BUILD_TOKEN.decimals}
            onPay={() => router.navigate('/pay')}
            onReceive={() => router.navigate('/receive')}
            onAddMoney={() => router.push('/add-funds')}
          />
          <Button
            testID="locks"
            variant="text"
            label={t('common:home.locksAndWithdrawals')}
            onPress={() => router.push('/withdraw')}
          />
        </>
      ) : (
        <View testID={status.testID} className="gap-4">
          <Stage
            hero={
              <Hero
                kind={
                  status.testID === 'home-loading'
                    ? 'waiting'
                    : status.testID === 'home-unreachable'
                      ? 'problem'
                      : 'wallet'
                }
                decorative
              />
            }
            title={status.title}
          >
            {status.body ? <Info title={status.title} lines={[status.body]} /> : null}
          </Stage>
          {device ? <AddressRow address={device.wallet} label={t('common:registeredTo')} /> : null}
          {status.action ? (
            <Button
              testID="setup-payments"
              variant="filled"
              label={status.action}
              onPress={() => router.push('/onboarding')}
            />
          ) : null}
          {status.retry ? (
            <Button testID="home-retry" variant="filled" label={status.retry} busy={busy} onPress={() => void next()} />
          ) : null}
        </View>
      )}
      {settlement.labelPending ? (
        <SettlementLabel
          count={settlement.unsettled?.count ?? 0}
          earliestExpiry={settlement.unsettled?.earliestExpiry ?? null}
          onContinue={() => void settlement.acknowledge()}
        />
      ) : null}
      {ready ? <RotationAlert /> : null}
      <View
        testID="network-chip"
        accessible
        className="self-start min-h-8 px-3 rounded-full border border-outline justify-center"
      >
        <AppText variant="label" tone="muted">
          {t(`common:network.${BUILD_NETWORK.labelKey}`)}
        </AppText>
      </View>
    </Screen>
  )
}
