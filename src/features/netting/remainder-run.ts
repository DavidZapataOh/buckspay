import { bytesToHex } from '@noble/hashes/utils.js'
import { payRemainder, type RemainderDeps, type RemainderTab, receiveRemainder, skipRemainder } from './remainder'

const REFRESH_MS = 1000

/**
 * What a phone does with what is left to pay while its session link is up: a creditor waits for the payment of
 * each of its tabs at once, a debtor pays when the person presses Pay, and the rows are read again as they change.
 */
export function startRemainder(input: {
  deps: RemainderDeps
  tabs: readonly RemainderTab[]
  refresh: () => Promise<void>
  close: () => void
}) {
  const { deps, tabs, refresh } = input
  const stop = new AbortController()
  const reload = () => refresh().catch(() => undefined)
  const tabOf = (id: string) => tabs.find((tab) => bytesToHex(tab.tab) === id)
  const timer = setInterval(reload, REFRESH_MS)

  for (const tab of tabs) {
    if (tab.role === 'creditor')
      void receiveRemainder(deps, tab, stop.signal)
        .catch(() => undefined)
        .then(reload)
  }

  return {
    async pay(id: string) {
      const tab = tabOf(id)
      if (!tab || tab.role !== 'debtor') return
      await payRemainder(deps, tab, stop.signal).catch(() => undefined)
      await reload()
    },
    async later(id: string) {
      const tab = tabOf(id)
      if (!tab) return
      await skipRemainder(deps.db, deps.session, tab.tab)
      await reload()
    },
    stop() {
      clearInterval(timer)
      stop.abort()
      input.close()
    },
  }
}
