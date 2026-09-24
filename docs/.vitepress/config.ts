import { defineConfig, type DefaultTheme } from 'vitepress'

// Shared sidebar for /guide/, /concepts/, /web-ui/ and /settings/ —
// Concepts, Web Interface and Settings are categories inside the Guide
// nav, not separate top-level nav entries.
const guideSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Getting Started',
    items: [
      { text: 'What It Is For', link: '/guide/use-cases' },
      { text: 'Quickstart', link: '/guide/quickstart' },
      { text: 'Deployment', link: '/guide/deployment' },
      { text: 'Configuration', link: '/guide/configuration' },
      { text: 'Models & Providers', link: '/guide/models' },
      { text: 'Telegram Bot', link: '/guide/telegram' },
      { text: 'Companion App (Android)', link: '/guide/companion-app' },
    ],
  },
  {
    text: 'Core Concepts',
    items: [
      { text: 'Overview', link: '/concepts/' },
      { text: 'Agent Instructions', link: '/concepts/instructions' },
      { text: 'Built-in Tools', link: '/concepts/tools' },
      { text: 'Captures & Strands', link: '/concepts/captures-and-strands' },
      { text: 'Memory System', link: '/concepts/memory' },
      { text: 'Personas', link: '/concepts/personas' },
      { text: 'Skills', link: '/concepts/skills' },
      { text: 'System Prompt', link: '/concepts/system-prompt' },
      { text: 'Tasks & Cronjobs', link: '/concepts/tasks-and-cronjobs' },
    ],
  },
  {
    text: 'Web Interface',
    items: [
      { text: 'Overview', link: '/web-ui/' },
      { text: 'Dashboard', link: '/web-ui/dashboard' },
      { text: 'Chat', link: '/web-ui/chat' },
      { text: 'Tasks', link: '/web-ui/tasks' },
      { text: 'Cronjobs', link: '/web-ui/cronjobs' },
      { text: 'Memory', link: '/web-ui/memory' },
      { text: 'Activity Logs', link: '/web-ui/activity-logs' },
      { text: 'Token Usage', link: '/web-ui/token-usage' },
      { text: 'Users', link: '/web-ui/users' },
      { text: 'Personas', link: '/web-ui/personas' },
      { text: 'Providers', link: '/web-ui/providers' },
      { text: 'Skills', link: '/web-ui/skills' },
      { text: 'Instructions', link: '/web-ui/instructions' },
    ],
  },
  {
    text: 'Settings',
    items: [
      { text: 'Overview', link: '/settings/' },
      { text: 'Agent', link: '/settings/agent' },
      { text: 'Agent Heartbeat', link: '/settings/agent-heartbeat' },
      { text: 'Health Monitor', link: '/settings/health-monitor' },
      { text: 'Memory', link: '/settings/memory' },
      { text: 'Secrets', link: '/settings/secrets' },
      { text: 'Speech-to-Text', link: '/settings/speech-to-text' },
      { text: 'Tasks', link: '/settings/tasks' },
      { text: 'Telegram', link: '/settings/telegram' },
      { text: 'Text-to-Speech', link: '/settings/text-to-speech' },
    ],
  },
]

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Offtangent Documentation',
  description: 'Self-hosted agent backend with captures, strands and a router. Talk first, the system sorts.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  // Allow http(s)://localhost:* links — they're examples for self-hosters,
  // not real links. Everything else is still validated.
  ignoreDeadLinks: [/^https?:\/\/localhost(:\d+)?(\/|$)/],

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
  ],

  // Exclude internal/contributor docs from the user-facing site build.
  // `agent_docs/` lives at the repo root, not under `docs/`, so VitePress
  // already won't crawl it — this is just a defense-in-depth filter.
  srcExclude: ['**/README.md'],

  markdown: {
    config(md) {
      // Render `[title]` after the language identifier on standalone code
      // blocks as a label above the block. VitePress' built-in [title]
      // syntax only applies inside `::: code-group`; this extends it to
      // every fenced code block so we don't have to wrap single blocks.
      const defaultFence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const info = token.info || ''
        const match = info.match(/\[(.+?)\]/)
        const html = defaultFence(tokens, idx, options, env, self)
        if (!match) return html
        const title = md.utils.escapeHtml(match[1])
        return `<div class="vp-code-block-title">${title}</div>${html}`
      }
    },
  },

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo.svg',
    siteTitle: 'Offtangent',

    nav: [
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/(guide|concepts|web-ui|settings)/' },
      { text: 'Reference', link: '/reference/env-vars', activeMatch: '/reference/' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/Kruppes/offtangent' },
          // Label the upstream as upstream, never as "the" source of this fork.
          { text: 'Upstream: Axiom', link: 'https://github.com/meteyou/axiom' },
        ],
      },
    ],

    sidebar: {
      '/guide/': guideSidebar,
      '/concepts/': guideSidebar,
      '/web-ui/': guideSidebar,
      '/settings/': guideSidebar,

      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Environment Variables', link: '/reference/env-vars' },
            { text: 'Configuration Files', link: '/reference/settings' },
            { text: 'File Paths', link: '/reference/file-paths' },
            { text: 'Auth API', link: '/reference/auth-api' },
            { text: 'Threads API', link: '/reference/threads-api' },
            { text: 'Projects API', link: '/reference/projects-api' },
            { text: 'Tasks API', link: '/reference/tasks-api' },
            { text: 'Captures API', link: '/reference/captures-api' },
            { text: 'Strands API', link: '/reference/strands-api' },
            { text: 'Feed API', link: '/reference/feed-api' },
            { text: 'Uploads API', link: '/reference/uploads-api' },
            { text: 'Artifacts API', link: '/reference/artifacts-api' },
            { text: 'Interaction blocks', link: '/reference/interaction-blocks' },
            { text: 'Voice API', link: '/reference/voice-api' },
            { text: 'Push API', link: '/reference/push-api' },
            { text: 'Model Policy API', link: '/reference/model-policy-api' },
            { text: 'Memory View API', link: '/reference/memory-view-api' },
            { text: 'Personas API', link: '/reference/personas-api' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/Kruppes/offtangent' }],

    footer: {
      message: 'Released under the MIT License. Forked from Axiom.',
    },

    search: {
      provider: 'local',
    },
  },
})
