/**
 * W7 D2: the read-aloud cache block in Settings, rendered for real (SSR) and
 * driven through its controller: loading, error, figures, empty, success and
 * failure of "empty cache". `$t` returns key plus parameters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SettingsSpeechCache from './components/SettingsSpeechCache.vue'
import { createSpeechCache, formatCacheBytes, type SpeechCacheApi, type SpeechCacheStats } from './speechCache'

function translate(key: string, ...args: unknown[]): string {
  const params = args[0]
  return params && typeof params === 'object' ? `${key}(${JSON.stringify(params)})` : key
}

const filled: SpeechCacheStats = { enabled: true, entries: 12, bytes: 3 * 1024 * 1024, maxBytes: 200 * 1024 * 1024, hits: 9, misses: 3 }

function api(over: Partial<SpeechCacheApi> = {}): SpeechCacheApi {
  return {
    get: vi.fn(async () => filled),
    clear: vi.fn(async () => ({ ...filled, entries: 0, bytes: 0, removedEntries: 12, removedBytes: filled.bytes })),
    ...over,
  }
}

async function render(controller: ReturnType<typeof createSpeechCache>): Promise<string> {
  vi.stubGlobal('useI18n', () => ({ t: translate, locale: { value: 'en' } }))
  const app = createSSRApp(SettingsSpeechCache, { controller })
  app.config.globalProperties.$t = translate
  app.component('AppIcon', defineComponent({ render: () => null }))
  // The real dialog is a portal; here only its props matter.
  app.component('ConfirmDialog', defineComponent({
    props: { open: Boolean, title: String, description: String },
    setup: props => () => props.open ? h('div', { 'data-testid': 'confirm-stub' }, `${props.title}|${props.description}`) : null,
  }))
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('read-aloud cache settings block', () => {
  it('shows a skeleton while loading', async () => {
    const html = await render(createSpeechCache(api()))
    expect(html).toContain('data-testid="speech-cache-loading"')
    expect(html).toContain('aria-busy="true"')
  })

  it('shows a retry on load failure', async () => {
    const ctl = createSpeechCache(api({ get: vi.fn(async () => { throw new Error('403') }) }))
    await ctl.load()
    const html = await render(ctl)
    expect(html).toContain('data-testid="speech-cache-error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('settings.retry')
  })

  it('shows entries, size, hits and misses and an enabled clear button', async () => {
    const ctl = createSpeechCache(api())
    await ctl.load()
    const html = await render(ctl)
    expect(html).toContain('data-testid="speech-cache-stats"')
    expect(html).toContain('>12<')
    expect(html).toContain('3 MB / 200 MB')
    expect(html).toContain('settings.speechCache.sinceStart({&quot;rate&quot;:75})')
    expect(html).toMatch(/data-testid="speech-cache-clear"(?![^>]*disabled)/)
  })

  it('says so when the cache is empty or switched off', async () => {
    const empty = createSpeechCache(api({ get: vi.fn(async () => ({ ...filled, entries: 0, bytes: 0, hits: 0, misses: 0 })) }))
    await empty.load()
    const emptyHtml = await render(empty)
    expect(emptyHtml).toContain('data-testid="speech-cache-empty"')
    expect(emptyHtml).toContain('settings.speechCache.sinceStartEmpty')
    const off = createSpeechCache(api({ get: vi.fn(async () => ({ enabled: false, entries: 0, bytes: 0, maxBytes: 0, hits: 0, misses: 0 })) }))
    await off.load()
    expect(await render(off)).toContain('data-testid="speech-cache-off"')
  })

  it('reports what was removed after clearing', async () => {
    const ctl = createSpeechCache(api())
    await ctl.load()
    expect(await ctl.clear()).toBe(true)
    const html = await render(ctl)
    expect(html).toContain('data-testid="speech-cache-cleared"')
    expect(html).toContain('settings.speechCache.cleared({&quot;count&quot;:12,&quot;size&quot;:&quot;3 MB&quot;})')
    expect(ctl.stats.value).toMatchObject({ entries: 0, bytes: 0 })
  })

  it('reports a failed clear and keeps the figures', async () => {
    const ctl = createSpeechCache(api({ clear: vi.fn(async () => { throw new Error('500') }) }))
    await ctl.load()
    expect(await ctl.clear()).toBe(false)
    const html = await render(ctl)
    expect(html).toContain('data-testid="speech-cache-failed"')
    expect(ctl.stats.value).toEqual(filled)
  })
})

describe('formatCacheBytes', () => {
  it('uses binary units with at most one decimal below 10', () => {
    expect(formatCacheBytes(0, 'en')).toBe('0 B')
    expect(formatCacheBytes(1536, 'en')).toBe('1.5 KB')
    expect(formatCacheBytes(200 * 1024 * 1024, 'en')).toBe('200 MB')
  })
})
