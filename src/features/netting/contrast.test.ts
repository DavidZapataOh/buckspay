import { describeScreenContrast } from '../../theme/contrast-check'

const screens = [
  'index-screen',
  'host-screen',
  'join-screen',
  'session-screen',
  'consent-view',
  'remainder-section',
  'entries',
].map((name) => `../features/netting/${name}.tsx`)

describeScreenContrast('netting screens contrast', screens, {
  tones: ['muted', 'danger', 'success'],
  variants: ['filled', 'tonal', 'text'],
})
