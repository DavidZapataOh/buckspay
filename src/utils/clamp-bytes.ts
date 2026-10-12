/** The longest start of `text` that fits in `max` bytes of UTF-8, without cutting a letter in half. */
export function clampBytes(text: string, max: number): string {
  const encoder = new TextEncoder()
  let used = 0
  let kept = ''
  for (const letter of text) {
    used += encoder.encode(letter).length
    if (used > max) break
    kept += letter
  }
  return kept
}
