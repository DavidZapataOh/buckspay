const marks: [string, number][] = []

/** Records a moment of a payment, by name. End-to-end builds only: in any other build this does nothing. */
export function mark(name: string) {
  if (process.env.EXPO_PUBLIC_E2E !== '1') return
  marks.push([name, performance.now()])
}

/** Holds a payment for `EXPO_PUBLIC_E2E_PAUSE` milliseconds, so a test can stop the app between two stages. End-to-end builds only. */
export function pause(): Promise<void> {
  const milliseconds = Number(process.env.EXPO_PUBLIC_E2E_PAUSE)
  if (process.env.EXPO_PUBLIC_E2E !== '1' || !(milliseconds > 0)) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Writes one `PAYTIME` line to the log: each mark's time since the first, never a key, an amount or an id. */
export function report() {
  if (process.env.EXPO_PUBLIC_E2E !== '1' || marks.length === 0) return
  const [, start] = marks[0]
  const durations = Object.fromEntries(marks.slice(1).map(([name, at]) => [name, Math.round(at - start)]))
  marks.length = 0
  console.log(`PAYTIME ${JSON.stringify(durations)}`)
}
