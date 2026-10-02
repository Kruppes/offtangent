/**
 * W5c settings shell, rendered with Vue's SSR renderer: the overview (grouped
 * list, search, empty search), the grouped area navigation, the theme choice
 * and the voice-replies switch in all of its states. `$t` resolves the real
 * English messages so a missing key shows up as the raw key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import en from '../../i18n/locales/en.json'
import Button from '~/components/ui/Button.vue'
import Label from '~/components/ui/Label.vue'
import Switch from '~/components/ui/Switch.vue'
import Skeleton from '~/components/ui/Skeleton.vue'
import SettingsOverview from './components/SettingsOverview.vue'
import SettingsSectionNav from './components/SettingsSectionNav.vue'
import SettingsAppearance from './components/SettingsAppearance.vue'
import SettingsVoiceReplies from './components/SettingsVoiceReplies.vue'
import { createVoiceReplies } from './voiceReplies'
import { SETTINGS_SECTIONS } from './settingsSections'

const theme = vi.hoisted(() => ({ mode: 'auto' as string, resolved: 'dark' as string }))
vi.mock('~/composables/useTheme', async () => {
  const { ref, computed } = await import('vue')
  return {
    useTheme: () => ({ mode: ref(theme.mode), resolvedMode: computed(() => theme.resolved), setMode: vi.fn() }),
  }
})
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }))

type Messages = Record<string, unknown>
function translate(key: string, ...args: unknown[]): string {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Messages | undefined)?.[part], en as Messages)
  if (typeof value !== 'string') return key
  const params = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

const Link = defineComponent({
  props: ['to'],
  setup: (props, { slots, attrs }) => () => h('a', { ...attrs, href: props.to }, slots.default?.()),
})

async function render(component: Component, props: Record<string, unknown> = {}) {
  const app = createSSRApp(component, props)
  app.component('NuxtLink', Link)
  app.component('AppIcon', defineComponent({ props: ['name'], setup: p => () => h('i', { 'data-icon': p.name }) }))
  app.component('Button', Button)
  app.component('Label', Label)
  app.component('Switch', Switch)
  app.component('Skeleton', Skeleton)
  app.config.globalProperties.$t = translate
  return renderToString(app)
}

afterEach(() => { theme.mode = 'auto'; theme.resolved = 'dark' })

describe('settings overview', () => {
  it('lists every area grouped into everyday and system, with deep links', async () => {
    const html = await render(SettingsOverview)
    expect(html).toContain('Everyday')
    expect(html).toContain('System')
    expect(html.indexOf('Everyday')).toBeLessThan(html.indexOf('>System<'))
    for (const section of SETTINGS_SECTIONS) {
      const href = section.save === 'link' ? section.to! : `/settings/${section.id}`
      expect(html, section.id).toContain(`href="${href}"`)
    }
    expect(html).not.toMatch(/settings\.[a-zA-Z]+\.[a-zA-Z]/)
  })

  it('has a labelled search field with a name', async () => {
    const html = await render(SettingsOverview)
    expect(html).toContain('role="search"')
    expect(html).toContain('<label for="settings-search"')
    expect(html).toContain('id="settings-search"')
    expect(html).toContain('name="settings-search"')
    expect(html).toContain('type="search"')
  })

  it('shows the matching areas and names the matching setting', async () => {
    const html = await render(SettingsOverview, { initialQuery: 'timezone' })
    expect(html).toContain('data-testid="settings-search-results"')
    expect(html).toContain('href="/settings/agent"')
    expect(html).not.toContain('href="/settings/memory"')
    expect(html).toContain('Timezone')
  })

  it('shows an empty state with a way back', async () => {
    const html = await render(SettingsOverview, { initialQuery: 'qqqzzz' })
    expect(html).toContain('data-testid="settings-search-empty"')
    expect(html).toContain('No setting matches')
    expect(html).toContain('Clear search')
  })
})

describe('settings area navigation', () => {
  it('marks the active area and links every area', async () => {
    const html = await render(SettingsSectionNav, { active: 'memory' })
    expect(html).toContain('aria-label="Settings areas"')
    expect(html).toMatch(/href="\/settings\/memory"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings\/memory"/)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('href="/logs"')
    expect(html).toContain('Opens its own page')
  })
})

describe('settings appearance', () => {
  it('offers system, light and dark as one named radio group', async () => {
    const html = await render(SettingsAppearance)
    expect(html).toContain('<legend')
    expect(html.match(/name="theme-mode"/g)).toHaveLength(3)
    for (const value of ['auto', 'light', 'dark']) expect(html).toContain(`data-theme-option="${value}"`)
    expect(html).toContain('System')
    expect(html).toMatch(/value="auto"[^>]*checked/)
    expect(html).toContain('Currently shown: Dark')
  })

  it('checks the stored mode', async () => {
    theme.mode = 'light'
    theme.resolved = 'light'
    const html = await render(SettingsAppearance)
    expect(html).toMatch(/value="light"[^>]*checked/)
    expect(html).not.toMatch(/value="auto"[^>]*checked/)
  })
})

describe('voice replies switch', () => {
  const api = { get: vi.fn(), set: vi.fn() }

  it('shows a skeleton while loading', async () => {
    const html = await render(SettingsVoiceReplies, { controller: createVoiceReplies(api) })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('id="voice-replies-enabled"')
  })

  it('shows the error with a retry button', async () => {
    const controller = createVoiceReplies(api)
    controller.state.value = 'error'
    const html = await render(SettingsVoiceReplies, { controller })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Voice replies could not be loaded.')
    expect(html).toContain('Try again')
  })

  it('renders a labelled, named switch with its state', async () => {
    const controller = createVoiceReplies(api)
    controller.state.value = 'ready'
    controller.enabled.value = true
    const html = await render(SettingsVoiceReplies, { controller })
    expect(html).toContain('for="voice-replies-enabled"')
    expect(html).toContain('id="voice-replies-enabled"')
    expect(html).toContain('name="voice-replies-enabled"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-describedby="voice-replies-hint"')
  })

  it('confirms a save and reports a failed one', async () => {
    const controller = createVoiceReplies(api)
    controller.state.value = 'ready'
    controller.feedback.value = 'saved'
    expect(await render(SettingsVoiceReplies, { controller })).toContain('Voice replies saved.')
    controller.feedback.value = 'failed'
    const html = await render(SettingsVoiceReplies, { controller })
    expect(html).toContain('Voice replies could not be saved.')
    expect(html).toContain('role="alert"')
  })
})

