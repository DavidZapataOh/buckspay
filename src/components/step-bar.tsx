import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { feedback } from '../feedback'
import { NAMESPACES } from '../i18n'

type State = 'done' | 'now' | 'todo'
const FILL: Record<State, number> = { done: 1, now: 0.5, todo: 0 }

function Segment({ state }: { state: State }) {
  const fill = useSharedValue(FILL[state])
  useEffect(() => {
    fill.set(withTiming(FILL[state], { duration: 350 }))
  }, [fill, state])
  const style = useAnimatedStyle(() => ({ width: `${fill.get() * 100}%` }))
  return (
    <View className="h-2 flex-1 overflow-hidden rounded-full bg-outline">
      <Animated.View className="h-full rounded-full bg-primary" style={style} />
    </View>
  )
}

/** Where the person is in a flow: one segment per step, the ones behind full, this one half, and a cue on each step forward. */
export function StepBar({ total, current }: { total: number; current: number }) {
  const { t } = useTranslation(NAMESPACES)
  const before = useRef(current)
  useEffect(() => {
    if (current > before.current) feedback.cue('step')
    before.current = current
  }, [current])
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common:step', { current: current + 1, total })}
      accessibilityValue={{ min: 1, max: total, now: current + 1 }}
      className="flex-row gap-2"
    >
      {Array.from({ length: total }, (_, index) => (
        <Segment key={index} state={index < current ? 'done' : index === current ? 'now' : 'todo'} />
      ))}
    </View>
  )
}
