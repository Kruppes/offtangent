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
    include: ['app/**/*.render.spec.ts'],
  },
})
