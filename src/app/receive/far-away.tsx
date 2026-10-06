import { FarAwayReceive } from '../../features/remote/far-away-receive'
import { useFarAwayReceive } from '../../features/remote/use-far-away-receive'

export default function ReceiveFarAway() {
  const far = useFarAwayReceive()
  if (!far.wallet) return null
  return (
    <FarAwayReceive
      wallet={far.wallet}
      mint={far.mint}
      tokenAccount={far.tokenAccount}
      busy={far.busy}
      onShare={far.share}
      onCreate={() => void far.create()}
    />
  )
}
