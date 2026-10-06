const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'
const VALUES = new Map(Array.from(ALPHABET, (char, value) => [char, value]))

/** RFC 9285. */
export function base45Encode(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const n = bytes[i] * 256 + bytes[i + 1]
      text += ALPHABET[n % 45] + ALPHABET[Math.floor(n / 45) % 45] + ALPHABET[Math.floor(n / 2025)]
    } else {
      text += ALPHABET[bytes[i] % 45] + ALPHABET[Math.floor(bytes[i] / 45)]
    }
  }
  return text
}

/** Null for anything that is not canonical Base45. */
export function base45Decode(text: string): Uint8Array | null {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 3) {
    const values = [text[i], text[i + 1], text[i + 2]].map((char) =>
      char === undefined ? undefined : VALUES.get(char),
    )
    const [c, d, e] = values
    if (c === undefined || d === undefined) return null
    if (text.length - i >= 3) {
      if (e === undefined) return null
      const n = c + d * 45 + e * 2025
      if (n > 0xffff) return null
      out.push(n >> 8, n & 0xff)
    } else {
      const n = c + d * 45
      if (n > 0xff) return null
      out.push(n)
    }
  }
  return Uint8Array.from(out)
}

/** Bytes that fit in `chars` Base45 characters. */
export const base45Capacity = (chars: number) => Math.floor(chars / 3) * 2 + (chars % 3 === 2 ? 1 : 0)
