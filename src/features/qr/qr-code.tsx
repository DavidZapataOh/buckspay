import { useMemo, useState } from 'react'
import { PixelRatio, View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
import { StatusNote } from '../../components/status-note'
import { layoutQr, QUIET_MODULES } from '../../transport/qr/layout'
import { qrMatrix } from '../../transport/qr/matrix'
import { qrPath } from '../../transport/qr/path'

/**
 * One QR code at a whole number of screen pixels per module. Black on white in both themes on purpose:
 * scanners expect dark modules on a light ground, and the white quiet zone is part of the code.
 * Pass `matrix` when the caller has already computed it for `text`.
 */
export function QrCode({
  text,
  matrix,
  accessibilityLabel,
  testID,
}: {
  text: string
  matrix?: boolean[][]
  accessibilityLabel: string
  testID?: string
}) {
  const [width, setWidth] = useState(0)
  const modules = useMemo(() => matrix ?? qrMatrix(text), [matrix, text])
  const path = useMemo(() => qrPath(modules), [modules])
  const layout = layoutQr(PixelRatio.getPixelSizeForLayoutSize(width), modules.length)
  const size = layout.sizePx / PixelRatio.get()
  const extent = modules.length + 2 * QUIET_MODULES

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      className="w-full items-center"
    >
      {width > 0 && (
        <Svg width={size} height={size} viewBox={`${-QUIET_MODULES} ${-QUIET_MODULES} ${extent} ${extent}`}>
          <Rect x={-QUIET_MODULES} y={-QUIET_MODULES} width={extent} height={extent} fill="#ffffff" />
          <Path d={path} fill="#000000" />
        </Svg>
      )}
      {width > 0 && !layout.crisp && (
        <StatusNote
          tone="danger"
          message="This screen is too small to show the code sharply. Try the other transport or paste the code."
        />
      )}
    </View>
  )
}
