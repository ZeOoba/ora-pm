import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

// Review finding: <Toaster /> was mounted in both App.tsx and PortalApp.tsx. PortalApp is
// rendered inside App's router, so portal routes had two live Toasters and every toast
// rendered twice. App.tsx owns the single Toaster for all routes.
const root = resolve(__dirname, '../..')

function collectTsx(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return collectTsx(full)
    return ['.tsx', '.ts'].includes(extname(full)) ? [full] : []
  })
}

describe('Toaster mount (review finding: duplicate toasts on portal routes)', () => {
  const files = [
    join(root, 'src/App.tsx'),
    ...collectTsx(join(root, 'src/portal')),
  ]

  it('mounts exactly one <Toaster across src/App.tsx and src/portal/**', () => {
    const hits = files.flatMap((file) => {
      const count = (readFileSync(file, 'utf-8').match(/<Toaster\b/g) ?? []).length
      return count > 0 ? [{ file, count }] : []
    })
    const total = hits.reduce((sum, h) => sum + h.count, 0)
    expect(total).toBe(1)
    expect(hits.map((h) => h.file)).toEqual([join(root, 'src/App.tsx')])
  })
})
