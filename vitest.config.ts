import { defineConfig } from 'vitest/config'
import path from 'node:path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@axiom/core/contracts': path.resolve(__dirname, 'packages/core/src/contracts/index.ts'),
      '@axiom/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@axiom/telegram': path.resolve(__dirname, 'packages/telegram/src/index.ts'),
      '@axiom/web-backend': path.resolve(__dirname, 'packages/web-backend/src/index.ts'),
      // Nuxt's `~` alias, so a frontend composable can be unit tested without
      // booting Nuxt. Only the web-frontend package uses it.
      '~': path.resolve(__dirname, 'packages/web-frontend/app'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Agent runs execute this suite inside the live container. Uncapped, one
    // worker per core grew to ~4 GB each and starved the server next to it.
    pool: 'forks',
    maxWorkers: 2,
    poolOptions: { forks: { execArgv: ['--max-old-space-size=2048'] } },
    // Every test file gets its own empty DATA_DIR and WORKSPACE_DIR, so a run
    // never reads the live /data of the machine it runs on.
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/src/**/*.test.ts', 'packages/web-frontend/**/*.test.ts', 'packages/web-frontend/**/*.render.spec.ts'],
  },
})
