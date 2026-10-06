import { QUIET_MODULES } from '../qr/layout'

/** A black-on-white RGBA image of the matrix with its quiet zone, for an independent decoder. */
export function rasterize(matrix: boolean[][], pixelsPerModule: number) {
  const width = (matrix.length + 2 * QUIET_MODULES) * pixelsPerModule
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  matrix.forEach((row, my) =>
    row.forEach((dark, mx) => {
      if (!dark) return
      for (let dy = 0; dy < pixelsPerModule; dy++) {
        for (let dx = 0; dx < pixelsPerModule; dx++) {
          const x = (mx + QUIET_MODULES) * pixelsPerModule + dx
          const y = (my + QUIET_MODULES) * pixelsPerModule + dy
          data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3)
        }
      }
    }),
  )
  return { data, width, height: width, colorSpace: 'srgb' as const }
}
