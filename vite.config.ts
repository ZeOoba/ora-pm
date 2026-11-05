import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Keep heavy third-party libs in their own long-cacheable chunks so no single chunk nears 500 kB.
        manualChunks(id) {
          // Vite normalises module ids to forward slashes on every platform.
          const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id)
          if (!m) return undefined
          const pkg = m[1]
          if (/^(recharts|victory-vendor|d3-.+|internmap|decimal\.js-light|es-toolkit|immer|reselect|redux|@reduxjs\/.+)$/.test(pkg)) return 'vendor-charts'
          if (pkg.startsWith('@radix-ui/') || /^(cmdk|aria-hidden|react-remove-scroll.*|@floating-ui\/.+)$/.test(pkg)) return 'vendor-radix'
          if (pkg.startsWith('@supabase/')) return 'vendor-supabase'
          if (pkg.startsWith('@stripe/')) return 'vendor-stripe'
          if (/^(react|react-dom|react-router|scheduler)$/.test(pkg)) return 'vendor-react'
          return undefined
        },
      },
    },
  },
})
