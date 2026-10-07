import { openURL } from 'expo-linking'
import { useNetwork } from '../../features/network/use-network'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { RewardsScreen } from '../../features/rewards/rewards-screen'
import { useRewardClaims } from '../../features/rewards/use-reward-claims'
import { useRewards } from '../../features/rewards/use-rewards'

export default function RewardsRoute() {
  const claims = useRewardClaims()
  const { records, error, refresh } = useRewards(claims)
  const { getExplorerUrl } = useNetwork()
  return (
    <RewardsScreen
      rows={records}
      error={error}
      symbol={BUILD_TOKEN.symbol}
      decimals={BUILD_TOKEN.decimals}
      onClaim={
        claims &&
        (async (options) => {
          await claims.claim(options)
          await refresh()
        })
      }
      onMove={
        claims &&
        (async () => {
          await claims.move()
          await refresh()
        })
      }
      onOpenSignature={(signature) => void openURL(getExplorerUrl(`tx/${signature}`))}
    />
  )
}
