import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    // This dev machine is RAM-constrained (~5.7 GB usable). The default
    // 'forks'/'threads' pool spawns workers that can hit VirtualAlloc OOM on
    // Windows. vmThreads is lighter and runs the suite reliably here. CI has
    // ample memory but this is harmless there too.
    pool: 'vmThreads',
  },
})
