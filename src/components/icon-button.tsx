import { type AndroidSymbol, unstable_getMaterialSymbolSourceAsync } from 'expo-symbols'
import { useEffect, useState } from 'react'
import { Image, type ImageSourcePropType, Pressable } from 'react-native'
import { useThemeColors } from '../theme/use-theme-colors'

// Rendered once per symbol for the whole app; the image is white and tinted where it is drawn.
const sources = new Map<AndroidSymbol, Promise<ImageSourcePropType | null>>()

function symbolSource(name: AndroidSymbol) {
  let source = sources.get(name)
  if (!source) {
    source = unstable_getMaterialSymbolSourceAsync(name, 24, 'white')
    sources.set(name, source)
  }
  return source
}

/** A 48 dp icon button with a borderless ripple, labelled for screen readers. */
export function IconButton({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: AndroidSymbol
  label: string
  onPress: () => void
  testID?: string
}) {
  const [muted, foreground] = useThemeColors('muted', 'foreground')
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      android_ripple={foreground ? { color: `${foreground}1f`, borderless: true, radius: 24 } : undefined}
      className="size-12 items-center justify-center rounded-full"
    >
      <Icon name={icon} color={muted} />
    </Pressable>
  )
}

// A rendered image rather than `SymbolView`: its glyph is text that grows with the font scale and is
// clipped by its fixed 24 dp box.
function Icon({ name, color }: { name: AndroidSymbol; color?: string }) {
  const [source, setSource] = useState<ImageSourcePropType | null>(null)
  useEffect(() => {
    let current = true
    void symbolSource(name).then((image) => current && setSource(image))
    return () => {
      current = false
    }
  }, [name])
  return source ? <Image source={source} className="size-6" style={{ tintColor: color }} /> : null
}
