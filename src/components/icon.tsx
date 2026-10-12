import { type AndroidSymbol, unstable_getMaterialSymbolSourceAsync } from 'expo-symbols'
import { useEffect, useState } from 'react'
import { Image, type ImageSourcePropType, View } from 'react-native'

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

// A rendered image rather than `SymbolView`: its glyph is text that grows with the font scale and is
// clipped by its fixed box.
export function Icon({ name, color, size = 24 }: { name: AndroidSymbol; color?: string; size?: number }) {
  const [source, setSource] = useState<ImageSourcePropType | null>(null)
  useEffect(() => {
    let current = true
    void symbolSource(name).then((image) => current && setSource(image))
    return () => {
      current = false
    }
  }, [name])
  if (!source) return <View style={{ width: size, height: size }} />
  return source ? (
    <Image
      source={source}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: size, height: size, tintColor: color }}
    />
  ) : null
}
