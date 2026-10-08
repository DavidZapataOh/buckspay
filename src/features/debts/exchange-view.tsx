import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Screen } from '../../components/screen'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { Transport } from '../../transport/types'
import { copy } from '../payment/copy'
import { QrPresenter } from '../qr/qr-presenter'
import { ScanScreen } from '../qr/scan-screen'
import { WaitingScreen } from '../transport/waiting'
import { debtsCopy } from './copy'
import type { DebtLink } from './use-debts'

/**
 * Runs one turn of a debt exchange over the chosen medium: the code on the screen (shown, with a button to scan the
 * friend's answer) or Nearby (waiting). `run` is started once; its end, its failure or a cancel leave through the props.
 */
export function ExchangeView<T>({
  link,
  title,
  run,
  onDone,
  onFail,
  onCancel,
  idleCode,
  overlay,
}: {
  link: DebtLink
  title: string
  run: (transport: Transport, signal: AbortSignal) => Promise<T>
  onDone: (result: T) => void
  onFail: (error: unknown) => void
  onCancel: () => void
  /** A code to show until there is a message to send (the friend code of an answering phone). */
  idleCode?: string
  /** Replaces the exchange screens while it is shown; the exchange keeps running. */
  overlay?: ReactNode
}) {
  const [scanning, setScanning] = useState(false)
  const latest = useRef({ link, run, onDone, onFail })
  useEffect(() => {
    latest.current = { link, run, onDone, onFail }
  })
  useEffect(() => {
    const controller = new AbortController()
    let opened: Transport | undefined
    latest.current.link
      .connect()
      .then((transport) => {
        opened = transport
        return latest.current.run(transport, controller.signal)
      })
      .then(
        (result) => !controller.signal.aborted && latest.current.onDone(result),
        (error: unknown) => !controller.signal.aborted && latest.current.onFail(error),
      )
    return () => {
      controller.abort()
      void opened?.close()
    }
  }, [])

  if (overlay) return <>{overlay}</>
  if (link.chosen !== 'qr') {
    return <WaitingScreen medium={link.chosen} title={title} onCancel={onCancel} cancelLabel={copy.review.cancel} />
  }
  if (scanning) {
    return (
      <ScanScreen
        hint={copy.scan.hint}
        hintTestID="debts-scan-hint"
        progress={link.session.progress}
        onText={link.session.push}
        onCancel={() => setScanning(false)}
        cancelLabel={copy.review.cancel}
      />
    )
  }
  return (
    <Screen testID="debts-exchange">
      <AppText variant="headline">{title}</AppText>
      {link.session.texts || idleCode ? (
        <QrPresenter texts={link.session.texts ?? [idleCode!]} accessibilityLabel={title} />
      ) : null}
      <AppText variant="body" tone="muted" accessibilityLiveRegion="polite">
        {copy.send.waiting}
      </AppText>
      <Button variant="tonal" label={copy.send.scanReceipt} onPress={() => setScanning(true)} />
      <Button variant="text" label={copy.review.cancel} onPress={onCancel} />
      <AppText variant="label" tone="muted">
        {debtsCopy.viaCode}
      </AppText>
    </Screen>
  )
}
