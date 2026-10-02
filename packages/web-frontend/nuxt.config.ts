import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import tailwindcss from '@tailwindcss/vite'
import { normalizeBuildSha } from './app/utils/buildSha'

const THEME_BOOT_SCRIPT = "(function(){var m='auto';try{var s=localStorage,v=s.getItem('offtangent-color-mode');if(v===null)v=s.getItem('axiom-color-mode');if(v==='dark'||v==='light'||v==='auto')m=v}catch(e){}var d=m==='dark'||(m==='auto'&&!!window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var c=document.documentElement.classList;c.toggle('dark',d);c.toggle('light',!d)})()"

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'))

/**
 * Build commit (W6b): the Docker build passes it as `GIT_SHA` (the image
 * build context has no `.git`); a local build asks git. Invalid or missing
 * values end up empty and the UI then shows the version alone.
 */
function resolveBuildSha(): string {
  const fromEnv = normalizeBuildSha(process.env.GIT_SHA)
  if (fromEnv) return fromEnv
  try {
    return normalizeBuildSha(execSync('git rev-parse --short=7 HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
  } catch {
    return ''
  }
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-04-05',
  devtools: { enabled: true },
  ssr: false,

  modules: ['@nuxtjs/i18n'],

  components: [
    {
      path: '~/components',
      pathPrefix: false,
    },
  ],

  css: ['~/assets/css/tailwind.css'],

  i18n: {
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'de', name: 'Deutsch', file: 'de.json' },
    ],
    defaultLocale: 'en',
    langDir: 'locales',
    restructureDir: 'app/i18n',
    strategy: 'no_prefix',
  },

  vite: {
    plugins: [
      tailwindcss(),
    ],
    server: {
      fs: {
        // Allow serving files from the workspace root (monorepo hoisted node_modules)
        allow: ['../..'],
      },
    },
    optimizeDeps: {
      exclude: ['nuxt/dist/app/composables/manifest'],
    },
  },

  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || '',
      appVersion: rootPkg.version || '0.0.0',
      buildSha: resolveBuildSha(),
      // Serve the thread inbox from in-memory demo data instead of the API.
      // Opt-in via `NUXT_PUBLIC_THREADS_MOCK=1`, so it is off in every normal
      // (production) build.
      threadsMock: process.env.NUXT_PUBLIC_THREADS_MOCK === '1',
    },
  },

  devServer: {
    port: 3001,
  },

  app: {
    head: {
      title: 'Offtangent',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Offtangent: self-hosted agent backend. Talk first, the system sorts.' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
      // Apply the stored colour mode before the first paint (the app is a
      // client-only SPA, so without this the page would flash in the default
      // theme until the bundle runs). Mirrors `initializeTheme` in
      // composables/useTheme.ts, including the legacy storage key.
      script: [{ innerHTML: THEME_BOOT_SCRIPT, tagPosition: 'head' }],
    },
  },
})
