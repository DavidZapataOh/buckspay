// Hermes has no Intl.Locale and no Intl.PluralRules (read from the device); i18next needs the second for plurals.
import '@formatjs/intl-locale/polyfill-force.js'
import '@formatjs/intl-pluralrules/polyfill-force.js'
import '@formatjs/intl-pluralrules/locale-data/en.js'
import '@formatjs/intl-pluralrules/locale-data/es.js'
import '@formatjs/intl-pluralrules/locale-data/pt.js'
