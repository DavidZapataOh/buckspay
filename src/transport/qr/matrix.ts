import { encode } from 'uqr'

/** The modules of the QR for `text` (dark is true): level M, no border. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 0 }).data
}
