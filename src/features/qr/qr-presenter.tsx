import { restoreSystemBrightnessAsync, setBrightnessAsync } from 'expo-brightness'
import { useKeepAwake } from 'expo-keep-awake'
import { useEffect, useMemo, useState } from 'react'
import { qrMatrix } from '../../transport/qr/matrix'
import { QrCode } from './qr-code'

export const QR_FPS = 5

/**
 * Shows the texts of one message in a loop. While mounted the screen is as bright as it goes and stays
 * awake; it announces nothing while cycling, the label says what the code is.
 */
export function QrPresenter({ texts, accessibilityLabel }: { texts: readonly string[]; accessibilityLabel: string }) {
  const matrices = useMemo(() => texts.map(qrMatrix), [texts])
  const [index, setIndex] = useState(0)
  useKeepAwake()

  useEffect(() => {
    void setBrightnessAsync(1)
    return () => void restoreSystemBrightnessAsync()
  }, [])

  useEffect(() => {
    if (texts.length < 2) return
    const timer = setInterval(() => setIndex((current) => (current + 1) % texts.length), 1000 / QR_FPS)
    return () => clearInterval(timer)
  }, [texts])

  const shown = index % texts.length
  return <QrCode text={texts[shown]} matrix={matrices[shown]} accessibilityLabel={accessibilityLabel} />
}
