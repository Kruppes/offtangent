/**
 * Render harness for the strand activity view.
 *
 * The repository has no headless browser, so the components are rendered with
 * Vue's own SSR renderer instead: real SFC compilation, real props, real
 * template logic, real HTML out. That covers what a screenshot would have
 * shown structurally (which rows appear, how deep they are indented, which
 * status a row carries, what the counter says) without pretending it also
 * covers pixels.
 *
 * Run: npx vitest run --config packages/web-frontend/vitest.render.config.ts
 */
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'app'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    root: __dirname,
    // Same caps as the root config: these runs share the live container.
    pool: 'forks',
    maxWorkers: 2,
    poolOptions: { forks: { execArgv: ['--max-old-space-size=2048'] } },
    include: ['app/**/*.render.spec.ts'],
  },
})
