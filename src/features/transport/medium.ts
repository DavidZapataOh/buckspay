/** The medium a phone talks over: the one the other phone asked for, else the one it remembers, else the first. */
export function mediumOf<T extends { id: string }>(
  entries: readonly T[],
  remembered: T | undefined,
  asked: string | undefined,
): T {
  return (asked !== undefined ? entries.find((entry) => entry.id === asked) : undefined) ?? remembered ?? entries[0]
}
