import { describe, it, expect } from 'vitest'
import { manualChunks } from '../../vite.chunks'

// The entry chunk must not statically import vendor-charts (index.html would modulepreload
// ~400 kB of recharts on every page). Tiny helpers shared by cn() and recharts (clsx, ...) must
// therefore land in vendor-ui, not be pulled into vendor-charts as a recharts dependency.
const nm = (pkg: string, file = 'dist/index.mjs') => `C:/repo/node_modules/${pkg}/${file}`

describe('vite manualChunks', () => {
  it.each(['clsx', 'tailwind-merge', 'class-variance-authority', 'tslib'])('puts %s in vendor-ui', (pkg) => {
    expect(manualChunks(nm(pkg))).toBe('vendor-ui')
  })

  it.each(['recharts', 'd3-scale', 'victory-vendor'])('keeps %s in vendor-charts', (pkg) => {
    expect(manualChunks(nm(pkg))).toBe('vendor-charts')
  })

  it('keeps react in vendor-react', () => {
    expect(manualChunks(nm('react', 'index.js'))).toBe('vendor-react')
  })

  // @tanstack/react-store (DataTable) and react-redux (recharts) both use this shim; unassigned,
  // it lands in vendor-charts and every DataTable list page statically imports the charts chunk.
  it('puts the use-sync-external-store React shim in vendor-react', () => {
    expect(manualChunks(nm('use-sync-external-store', 'shim/index.js'))).toBe('vendor-react')
  })
})
