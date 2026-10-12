import { Text, View } from 'react-native'

const tones = { strong: 'text-strong', success: 'text-success', danger: 'text-danger' }

/** The number is the hero: big, with the unit small beside it. */
export function Amount({
  value,
  symbol,
  tone = 'strong',
  size = 'hero',
  testID,
}: {
  value: string
  symbol: string
  tone?: keyof typeof tones
  size?: 'hero' | 'row'
  testID?: string
}) {
  const big = size === 'hero'
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${value} ${symbol}`}
      className="flex-row items-baseline justify-center gap-2"
    >
      <Text
        className={`${big ? 'text-6xl leading-[68px]' : 'text-3xl leading-10'} font-bold ${tones[tone]}`}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {value}
      </Text>
      <Text
        className={`${big ? 'text-xl leading-7' : 'text-base leading-6'} font-medium text-muted`}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {symbol}
      </Text>
    </View>
  )
}
