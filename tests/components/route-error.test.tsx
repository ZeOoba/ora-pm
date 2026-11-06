import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { isChunkLoadError, tryAutoReload, clearChunkReloadFlag, CHUNK_RELOAD_KEY } from '../../src/components/route-error'
import { RouteErrorView } from '../../src/components/RouteError'

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    has: (k: string) => m.has(k),
  }
}

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/Foo-abc.js',
    'Importing a module script failed.',
    'error loading dynamically imported module',
  ])('matches %s', (msg) => {
    expect(isChunkLoadError(new TypeError(msg))).toBe(true)
    expect(isChunkLoadError({ message: msg })).toBe(true)
    expect(isChunkLoadError(msg)).toBe(true)
  })
  it('rejects other errors and junk', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
    expect(isChunkLoadError(42)).toBe(false)
  })
})

describe('tryAutoReload', () => {
  const chunkErr = new Error('Failed to fetch dynamically imported module')
  it('reloads once, then refuses', () => {
    const store = memStore()
    let reloads = 0
    expect(tryAutoReload(chunkErr, store, () => reloads++)).toBe(true)
    expect(tryAutoReload(chunkErr, store, () => reloads++)).toBe(false)
    expect(reloads).toBe(1)
  })
  it('never reloads for non-chunk errors', () => {
    let reloads = 0
    expect(tryAutoReload(new Error('boom'), memStore(), () => reloads++)).toBe(false)
    expect(reloads).toBe(0)
  })
  it('does not loop when storage throws', () => {
    const bad = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
    let reloads = 0
    expect(tryAutoReload(chunkErr, bad, () => reloads++)).toBe(false)
    expect(reloads).toBe(0)
  })
  it('clearChunkReloadFlag removes the flag and swallows storage errors', () => {
    const store = memStore({ [CHUNK_RELOAD_KEY]: '1' })
    clearChunkReloadFlag(store)
    expect(store.has(CHUNK_RELOAD_KEY)).toBe(false)
    expect(() => clearChunkReloadFlag({ getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error('x') } })).not.toThrow()
  })
})

describe('RouteErrorView', () => {
  it('shows a reload notice for chunk failures', () => {
    const html = renderToStaticMarkup(createElement(RouteErrorView, { error: new Error('Failed to fetch dynamically imported module: /a.js') }))
    expect(html).toContain("Couldn&#x27;t load this page")
    expect(html).toContain('Reload')
    expect(html).not.toContain('/a.js')
  })
  it('hides the raw message for other errors and links home', () => {
    const html = renderToStaticMarkup(createElement(RouteErrorView, { error: new Error('secret internal detail') }))
    expect(html).not.toContain('secret internal detail')
    expect(html).toContain("Couldn&#x27;t load this page")
    expect(html).toContain('href="/"')
    expect(html).toContain('Reload')
  })
})
