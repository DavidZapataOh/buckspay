/**
 * Runs the steps of the work a relayer owes, one after the other, and reports every step that failed once all have run,
 * so one failure never hides another and none is dropped.
 */
export async function runAll(steps: readonly (readonly [name: string, work: () => Promise<unknown>])[]): Promise<void> {
  const failures: string[] = []
  for (const [name, work] of steps) {
    try {
      await work()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`The relay work did not finish. ${failures.join(' ')}`)
}
