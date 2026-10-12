// Hermes has no Intl.PluralRules (read from the device) and i18next needs it for plurals. The polyfill takes the plain
// language codes this app uses; i18next reads Intl.Locale only inside a try block with a fallback, so that one is not added.
import '@formatjs/intl-pluralrules/polyfill-force.js'
import '@formatjs/intl-pluralrules/locale-data/en.js'
import '@formatjs/intl-pluralrules/locale-data/es.js'
import '@formatjs/intl-pluralrules/locale-data/pt.js'
