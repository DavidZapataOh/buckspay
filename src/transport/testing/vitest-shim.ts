/**
 * The subset of Vitest that `describeTransportContract` uses, so the same suite runs inside the app
 * (end-to-end builds only: Metro aliases `vitest` to this file there).
 */
type Test = { name: string; run: () => Promise<void> | void }
const stack: string[] = []
const tests: Test[] = []

export function describe(name: string, body: () => void) {
  stack.push(name)
  body()
  stack.pop()
}

export function it(name: string, run: () => Promise<void> | void) {
  tests.push({ name: [...stack, name].join(' > '), run })
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((v, i) => v === b[i])
  if (typeof a === 'object' && typeof b === 'object' && a && b) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => same((a as never)[k], (b as never)[k]))
  }
  return false
}

export function expect(actual: unknown) {
  const fail = (what: string) => {
    throw new Error(`expected ${what}`)
  }
  return {
    toEqual: (expected: unknown) => same(actual, expected) || fail(`${String(actual)} to equal ${String(expected)}`),
    toBe: (expected: unknown) => Object.is(actual, expected) || fail(`${String(actual)} to be ${String(expected)}`),
    toBeInstanceOf: (type: new (...args: never[]) => unknown) =>
      actual instanceof type || fail('an instance of the class'),
    toHaveLength: (length: number) => (actual as { length: number }).length === length || fail(`length ${length}`),
    toBeGreaterThan: (than: number) => (actual as number) > than || fail(`${String(actual)} > ${than}`),
  }
}

export async function runAll(timeoutMs = 20_000): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const results = []
  for (const test of tests.splice(0)) {
    try {
      await Promise.race([
        Promise.resolve(test.run()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
      ])
      results.push({ name: test.name, ok: true })
    } catch (error) {
      results.push({ name: test.name, ok: false, error: String(error) })
    }
  }
  return results
}
