import { describe, it, expect, vi } from 'vitest'
import { runExclusive } from '../../src/lib/run-exclusive'

describe('runExclusive', () => {
  it('skips a second concurrent call without invoking fn', async () => {
    const flag = { current: false }
    let release!: (v: string) => void
    const fn1 = vi.fn(() => new Promise<string>((r) => { release = r }))
    const fn2 = vi.fn(async () => 'second')
    const p1 = runExclusive(flag, fn1)
    expect(flag.current).toBe(true) // set synchronously, before fn1 settles
    expect(await runExclusive(flag, fn2)).toBeUndefined()
    expect(fn2).not.toHaveBeenCalled()
    release('first')
    expect(await p1).toBe('first')
    expect(fn1).toHaveBeenCalledTimes(1)
  })
  it('clears the flag after resolve so a later call runs', async () => {
    const flag = { current: false }
    expect(await runExclusive(flag, async () => 1)).toBe(1)
    expect(flag.current).toBe(false)
    expect(await runExclusive(flag, async () => 2)).toBe(2)
  })
  it('clears the flag after reject and propagates the rejection', async () => {
    const flag = { current: false }
    await expect(runExclusive(flag, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(flag.current).toBe(false)
    expect(await runExclusive(flag, async () => 'ok')).toBe('ok')
  })
})
