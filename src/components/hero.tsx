import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { useThemeColors } from '../theme/use-theme-colors'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)
const AnimatedPath = Animated.createAnimatedComponent(Path)
const AnimatedRect = Animated.createAnimatedComponent(Rect)

export type HeroKind = 'done' | 'waiting' | 'nearby' | 'problem' | 'scan'

const RING = 2 * Math.PI * 58
const CHECK = 80

function Frame({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 160 160">
      {children}
    </Svg>
  )
}

/** A ring closes and the check draws itself. */
function Done({ size }: { size: number }) {
  const [success, container] = useThemeColors('success', 'success-container')
  const calm = useReducedMotion()
  const ring = useSharedValue(calm ? 0 : RING)
  const check = useSharedValue(calm ? 0 : CHECK)
  const pop = useSharedValue(calm ? 1 : 0.7)
  useEffect(() => {
    if (calm) return
    ring.set(withTiming(0, { duration: 450, easing: Easing.out(Easing.cubic) }))
    check.set(withDelay(350, withTiming(0, { duration: 300 })))
    pop.set(withSpring(1, { damping: 9 }))
  }, [calm, check, pop, ring])
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: ring.get() }))
  const checkProps = useAnimatedProps(() => ({ strokeDashoffset: check.get() }))
  const style = useAnimatedStyle(() => ({ transform: [{ scale: pop.get() }] }))
  return (
    <Animated.View style={style}>
      <Frame size={size}>
        <Circle cx={80} cy={80} r={58} fill={container} />
        <AnimatedCircle
          cx={80}
          cy={80}
          r={58}
          fill="none"
          stroke={success}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={RING}
          rotation={-90}
          origin="80, 80"
          animatedProps={ringProps}
        />
        <AnimatedPath
          d="M54 82 L73 101 L108 62"
          fill="none"
          stroke={success}
          strokeWidth={10}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={CHECK}
          animatedProps={checkProps}
        />
      </Frame>
    </Animated.View>
  )
}

/** An arc going round a quiet track. */
function Waiting({ size }: { size: number }) {
  const [primary, outline] = useThemeColors('primary', 'outline')
  const calm = useReducedMotion()
  const turn = useSharedValue(0)
  useEffect(() => {
    if (!calm) turn.set(withRepeat(withTiming(360, { duration: 1100, easing: Easing.linear }), -1))
  }, [calm, turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }))
  const arc = 2 * Math.PI * 56
  return (
    <Animated.View style={style}>
      <Frame size={size}>
        <Circle cx={80} cy={80} r={56} fill="none" stroke={outline} strokeWidth={10} />
        <Circle
          cx={80}
          cy={80}
          r={56}
          fill="none"
          stroke={primary}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${arc * 0.28} ${arc}`}
        />
      </Frame>
    </Animated.View>
  )
}

function Wave({ delay, color }: { delay: number; color?: string }) {
  const calm = useReducedMotion()
  const spread = useSharedValue(calm ? 0.5 : 0)
  useEffect(() => {
    if (!calm) {
      spread.set(withDelay(delay, withRepeat(withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }), -1)))
    }
  }, [calm, delay, spread])
  const props = useAnimatedProps(() => ({ r: 24 + 50 * spread.get(), strokeOpacity: 0.6 * (1 - spread.get()) }))
  return <AnimatedCircle cx={80} cy={80} fill="none" stroke={color} strokeWidth={4} animatedProps={props} />
}

/** Waves spreading from this phone while it looks for the other one. */
function Nearby({ size }: { size: number }) {
  const [primary, onPrimary] = useThemeColors('primary', 'on-primary')
  return (
    <Frame size={size}>
      <Wave delay={0} color={primary} />
      <Wave delay={600} color={primary} />
      <Wave delay={1200} color={primary} />
      <Circle cx={80} cy={80} r={22} fill={primary} />
      <Circle cx={80} cy={80} r={8} fill={onPrimary} />
    </Frame>
  )
}

/** A soft alert that shakes once: something needs the person, nothing is lost. */
function Problem({ size }: { size: number }) {
  const [warning, container] = useThemeColors('warning', 'warning-container')
  const calm = useReducedMotion()
  const shake = useSharedValue(0)
  useEffect(() => {
    if (!calm) {
      shake.set(
        withSequence(
          withTiming(-8, { duration: 60 }),
          withTiming(8, { duration: 90 }),
          withTiming(-5, { duration: 80 }),
          withTiming(0, { duration: 60 }),
        ),
      )
    }
  }, [calm, shake])
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }] }))
  return (
    <Animated.View style={style}>
      <Frame size={size}>
        <Circle cx={80} cy={80} r={58} fill={container} />
        <Rect x={73} y={44} width={14} height={46} rx={7} fill={warning} />
        <Circle cx={80} cy={110} r={8} fill={warning} />
      </Frame>
    </Animated.View>
  )
}

/** A frame with a line sweeping it: the camera is looking. */
function Scan({ size }: { size: number }) {
  const [muted, primary] = useThemeColors('muted', 'primary')
  const calm = useReducedMotion()
  const sweep = useSharedValue(calm ? 0.5 : 0)
  useEffect(() => {
    if (!calm) sweep.set(withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }), -1, true))
  }, [calm, sweep])
  const props = useAnimatedProps(() => ({ y: 42 + 74 * sweep.get() }))
  const corner = {
    fill: 'none',
    stroke: muted,
    strokeWidth: 8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const
  return (
    <Frame size={size}>
      <Path d="M30 58 V38 a8 8 0 0 1 8 -8 H58" {...corner} />
      <Path d="M102 30 H122 a8 8 0 0 1 8 8 V58" {...corner} />
      <Path d="M130 102 V122 a8 8 0 0 1 -8 8 H102" {...corner} />
      <Path d="M58 130 H38 a8 8 0 0 1 -8 -8 V102" {...corner} />
      <AnimatedRect x={44} width={72} height={4} rx={2} fill={primary} animatedProps={props} />
    </Frame>
  )
}

const scenes = { done: Done, waiting: Waiting, nearby: Nearby, problem: Problem, scan: Scan }

/** The picture of what is going on, so the screen needs fewer words. */
export function Hero({
  kind,
  label,
  decorative = false,
  size = 160,
}: {
  kind: HeroKind
  label?: string
  /** The title beside it already says it. */
  decorative?: boolean
  size?: number
}) {
  const Scene = scenes[kind]
  return decorative ? (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden className="items-center">
      <Scene size={size} />
    </View>
  ) : (
    <View accessible accessibilityRole="image" accessibilityLabel={label} className="items-center">
      <Scene size={size} />
    </View>
  )
}
