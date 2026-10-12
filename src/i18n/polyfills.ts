import { installPluralRules } from './plural-rules'

// Hermes has no Intl.PluralRules (read from the device), and i18next needs it to pick a plural form.
installPluralRules()
