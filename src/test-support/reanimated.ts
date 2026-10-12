// Test double for react-native-reanimated: animated components are the plain ones, values never move.
const Animated = {
  View: 'View',
  Text: 'Text',
  createAnimatedComponent: <T>(component: T) => component,
}

export default Animated
export const { View, Text, createAnimatedComponent } = Animated
export const useSharedValue = <T>(value: T) => {
  const shared = { value, get: () => shared.value, set: (next: T) => void (shared.value = next) }
  return shared
}
export const useAnimatedStyle = () => ({})
export const useAnimatedProps = () => ({})
export const useReducedMotion = () => false
export const withTiming = <T>(value: T) => value
export const withSpring = <T>(value: T) => value
export const withRepeat = <T>(value: T) => value
export const withDelay = <T>(_delay: number, value: T) => value
export const withSequence = <T>(...values: T[]) => values[values.length - 1]
export const cancelAnimation = () => {}
export const Easing = {
  linear: 0,
  quad: 0,
  cubic: 0,
  out: () => 0,
  inOut: () => 0,
}
