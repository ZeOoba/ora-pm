import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
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
