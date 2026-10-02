import { useCSSVariable } from 'uniwind'

/**
 * Theme colors for props that take no class name, by token name. A token missing from the theme is
 * `undefined`, so the platform's default color applies instead of an invalid one.
 */
export function useThemeColors(...names: string[]): (string | undefined)[] {
  return useCSSVariable(names.map((name) => `--color-${name}`)).map((value) =>
    typeof value === 'string' ? value : undefined,
  )
}
