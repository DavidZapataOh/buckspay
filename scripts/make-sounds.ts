import { mkdirSync, writeFileSync } from 'node:fs'
import { renderTone, TONES, wavFile } from '../src/feedback/synth.ts'

mkdirSync(new URL('../assets/sounds/', import.meta.url), { recursive: true })
for (const [name, tone] of Object.entries(TONES)) {
  writeFileSync(new URL(`../assets/sounds/${name}.wav`, import.meta.url), wavFile(renderTone(tone)))
}
