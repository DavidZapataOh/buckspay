import { router } from 'expo-router'
import { useEffect } from 'react'
import { BUILD_TOKEN } from '../../../features/pay/tokens'
import { ConsentView } from '../../../features/netting/consent-view'
import { HostScreen } from '../../../features/netting/host-screen'
import { SessionScreen } from '../../../features/netting/session-screen'
import { sessionView } from '../../../features/netting/session-view'
import { useHostSession } from '../../../features/netting/use-session'

export default function NettingHost() {
  const session = useHostSession()
  const { open } = session
  useEffect(() => {
    void open()
  }, [open])
  if (session.outcome && session.view) {
    return (
      <SessionScreen
        view={session.view}
        rows={session.remainder}
        symbol={BUILD_TOKEN.symbol}
        decimals={BUILD_TOKEN.decimals}
      />
    )
  }
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
  const view =
    session.view ??
    sessionView(
      { status: 0, role: 0, expires: null, proof: null, nothing: false, recordPending: false, remainder: [], count: 1 },
      0,
    )
  return (
    <HostScreen
      view={view}
      invite={session.invite ?? ''}
      failure={session.failure}
      onStart={session.start}
      onCancel={() => {
        session.cancel()
        router.back()
      }}
    />
  )
}
