export const QUIET_MODULES = 4
export const MIN_PIXELS_PER_MODULE = 4

export type QrLayout = { pixelsPerModule: number; sizePx: number; quietPx: number; crisp: boolean }

/** The largest whole number of device pixels per module that fits `availablePx` with the quiet zone. */
export function layoutQr(availablePx: number, modules: number): QrLayout {
  const total = modules + 2 * QUIET_MODULES
  const pixelsPerModule = Math.max(1, Math.floor(availablePx / total))
  return {
    pixelsPerModule,
    sizePx: pixelsPerModule * total,
    quietPx: pixelsPerModule * QUIET_MODULES,
    crisp: pixelsPerModule >= MIN_PIXELS_PER_MODULE,
  }
}
