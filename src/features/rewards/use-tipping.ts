import { useEffect, useState } from 'react'
import { BUILD_TOKEN } from '../pay/tokens'
import type { TippingSettings } from '../settings/settings'
import type { TipTerms } from './seams'
import { MIN_TIP_BOND } from './copy'
import { loadTipping, saveTipping } from './tip-setting'

/**
 * The tipping switch and the tip a payment pays. Both are absent without terms, and the switch stays absent until the
 * stored choice has been read so it never flashes the wrong position.
 */
export function useTipping(terms: TipTerms | undefined) {
  const [on, setOn] = useState<boolean>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    loadTipping().then(setOn, (failure: unknown) =>
      setError(`Couldn’t read the tipping setting. ${failure instanceof Error ? failure.message : String(failure)}`),
    )
  }, [])
  const settings: TippingSettings | undefined =
    terms && on !== undefined
      ? {
          on,
          wordValue: terms.wordValue,
          bond: terms.bond,
          symbol: BUILD_TOKEN.symbol,
          decimals: BUILD_TOKEN.decimals,
          onToggle: (next) => {
            setOn(next)
            saveTipping(next).catch((failure: unknown) => {
              setOn(!next)
              setError(
                `Couldn’t save the tipping setting. ${failure instanceof Error ? failure.message : String(failure)}`,
              )
            })
          },
        }
      : undefined
  const tip = terms && on && terms.bond >= MIN_TIP_BOND ? { value: terms.wordValue } : undefined
  return { settings, tip, error }
}
