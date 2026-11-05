// Rollup manualChunks for vite.config.ts (separate module so tests can import it without
// loading the Vite plugins). Keeps heavy third-party libs in their own long-cacheable chunks so
// no single chunk nears 500 kB.
export function manualChunks(id: string): string | undefined {
  // Vite normalises module ids to forward slashes on every platform.
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id)
  if (!m) return undefined
  const pkg = m[1]
  if (/^(recharts|victory-vendor|d3-.+|internmap|decimal\.js-light|es-toolkit|immer|reselect|redux|@reduxjs\/.+)$/.test(pkg)) return 'vendor-charts'
  if (pkg.startsWith('@radix-ui/') || /^(cmdk|aria-hidden|react-remove-scroll.*|@floating-ui\/.+)$/.test(pkg)) return 'vendor-radix'
  // Tiny class/helper libs shared by cn() (entry) and recharts. Left unassigned, Rollup folds them
  // into vendor-charts as a recharts dependency, and index.html then modulepreloads the charts
  // chunk on every page.
  if (/^(clsx|tailwind-merge|class-variance-authority|tslib)$/.test(pkg)) return 'vendor-ui'
  if (pkg.startsWith('@supabase/')) return 'vendor-supabase'
  if (pkg.startsWith('@stripe/')) return 'vendor-stripe'
  // use-sync-external-store is shared by @tanstack/react-store (DataTable) and react-redux (recharts).
  if (/^(react|react-dom|react-router|scheduler|use-sync-external-store)$/.test(pkg)) return 'vendor-react'
  return undefined
}
