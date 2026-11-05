/**
 * Runs `fn` unless `flag` is already set. The flag is set synchronously before `fn` is called (so a
 * second click in the same tick is skipped, which React state cannot guarantee) and cleared in
 * `finally` (also on rejection, which propagates). Returns undefined when skipped.
 */
export async function runExclusive<T>(flag: { current: boolean }, fn: () => Promise<T>): Promise<T | undefined> {
  if (flag.current) return undefined
  flag.current = true
  try {
    return await fn()
  } finally {
    flag.current = false
  }
}
