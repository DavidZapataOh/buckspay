import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage, setLanguage } from '.'
import type { Language } from './languages'
import { loadLanguagePreference } from './preference'

/** The language in use and the person's choice; `null` means they follow the phone. Repaints when either changes. */
export function useLanguage() {
  useTranslation()
  const [choice, setChoice] = useState<Language | null>(null)
  useEffect(() => {
    let current = true
    void loadLanguagePreference().then((stored) => {
      if (current) setChoice(stored)
    })
    return () => {
      current = false
    }
  }, [])

  async function choose(next: Language | null) {
    await setLanguage(next)
    setChoice(next)
  }

  return { language: currentLanguage(), choice, choose }
}
