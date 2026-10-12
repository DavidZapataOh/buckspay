import { router } from 'expo-router'
import { BUILD_TOKEN } from '../../../features/pay/tokens'
import { ConsentView } from '../../../features/netting/consent-view'
import { JoinScreen } from '../../../features/netting/join-screen'
import { SessionScreen } from '../../../features/netting/session-screen'
import { useJoinSession } from '../../../features/netting/use-session'

export default function NettingJoin() {
  const session = useJoinSession()
  if (session.consent) {
    return (
      <ConsentView
        view={session.consent}
        symbol={BUILD_TOKEN.symbol}
        decimals={BUILD_TOKEN.decimals}
        onSign={() => session.answer(true)}
        onDecline={() => session.answer(false)}
      />
    )
  }
  if (session.view && (session.outcome || session.phase === 'running')) {
    return <SessionScreen view={session.view} symbol={BUILD_TOKEN.symbol} decimals={BUILD_TOKEN.decimals} />
  }
  return (
    <JoinScreen
      phase={
        session.phase === 'idle' || session.phase === 'scan'
          ? 'scan'
          : session.phase === 'not-found'
            ? 'not-found'
            : 'connecting'
      }
      onText={(text) => void session.join(text)}
      onCancel={() => {
        session.cancel()
        router.back()
      }}
    />
  )
}
