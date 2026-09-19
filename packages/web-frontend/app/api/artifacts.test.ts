import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { artifactDocument, useArtifactsApi } from './artifacts'

afterEach(() => vi.unstubAllGlobals())
describe('artifact isolation', () => {
  it('places the restrictive CSP before any untrusted HTML', async () => {
    const html = await artifactDocument(new Blob(['<script>fetch("/api/settings")</script>']), 'html')
    expect(html.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    for (const rule of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'"]) expect(html).toContain(rule)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'))
  })
  it('embeds SVG as image data, not executable markup', async () => {
    const html = await artifactDocument(new Blob(['<svg><script>alert(1)</script></svg>']), 'svg')
    expect(html).toContain('src="data:image/svg+xml;base64,')
    expect(html).not.toContain('<svg>')
  })
  it('fetches capability bytes with no app token, cookies, referrer or redirects', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.test' } })
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '' } }))
    vi.stubGlobal('useApi', () => ({ apiFetch: vi.fn().mockResolvedValue({ artifact: { kind: 'html' }, contentUrl: '/api/artifacts/id/content?t=capability' }) }))
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['hello']) })
    vi.stubGlobal('fetch', fetch)
    const result = await useArtifactsApi().loadArtifact('id')
    expect(fetch.mock.calls[0]![0].href).toBe('https://app.test/api/artifacts/id/content?t=capability')
    expect(fetch.mock.calls[0]![1]).toEqual({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
    expect(result.document).not.toContain('capability')
  })
  it('pins iframe isolation and parent-owned download/fullscreen, with no message bridge', () => {
    const source = readFileSync(new URL('../components/ChatArtifact.vue', import.meta.url), 'utf8')
    expect(source).toContain('sandbox="allow-scripts"')
    expect(source).toContain('referrerpolicy="no-referrer"')
    expect(source).toContain(':title=')
    expect(source).toContain('requestFullscreen()')
    expect(source).toContain(':download="filename"')
    expect(source).not.toContain('allow-same-origin')
    expect(source).not.toContain('postMessage')
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain(':src=')
  })
})
