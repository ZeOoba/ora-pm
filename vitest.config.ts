import path from 'node:path'
import { defineConfig, configDefaults } from 'vitest/config'

// Pin a DST-observing zone for the whole run (local dev and CI alike) so date-only arithmetic
// is exercised across real 23/25-hour days; CI runners default to UTC, where DST bugs hide.
// Set on the main process before workers start, and passed to workers via test.env.
const TEST_TZ = 'America/New_York'
process.env.TZ = TEST_TZ

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    environment: 'node',
    env: { TZ: TEST_TZ },
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    // Pool selection is environment-aware:
    // - Local dev machine is RAM-constrained (~5.7 GB usable); the default
    //   'forks'/'threads' pool spawns workers that can hit VirtualAlloc OOM on
    //   Windows, so we use the lighter 'vmThreads' pool there.
    // - 'vmThreads' runs each test file in a Node `vm` context, whose V8 memory
    //   handling is fragile and version-sensitive — under load it segfaults
    //   (SIGSEGV / exit 139) on CI's Node 20. So CI uses the robust 'forks' pool.
    pool: process.env.CI ? 'forks' : 'vmThreads',
  },
})
