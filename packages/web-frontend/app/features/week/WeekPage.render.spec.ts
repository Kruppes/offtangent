import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { ref } from 'vue'
import { useApi } from '~/composables/useApi'
import * as captures from '~/api/captures'
import * as now from '~/api/now'
import * as week from '~/features/week/weekStats'
import * as localDay from '~/utils/localDay'
import { all, APP_DIR, button, byTestId, click, flush, loadSfc, mountNode, text, unmountAll } from '~/features/testing/nodeRenderer'

const WeekPage = loadSfc(path.join(APP_DIR, 'features/week/WeekPage.vue'), { '~/api/captures': captures, '~/api/now': now, './weekStats': week, '~/utils/localDay': localDay })
const capture = (id: string, createdAt: string, status: string, strandId: string | null) => ({ id, text: 'never shown', createdAt, status, strandId, attachments: [] })
const decision = (captureId: string, state: string) => ({ id: `d-${captureId}`, createdAt: '2026-01-07T09:00:00Z', captureId, title: null, action: 'append', confidence: 0.9, rationale: '', state, alternatives: [] })
let page: { captures: unknown[]; decisions: unknown[] }
let fail = false
beforeEach(() => {
  // Wednesday noon, so this week runs Monday 2026-01-05 to Sunday 2026-01-11 in any test time zone.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-07T12:00:00Z'))
  fail = false
  page = {
    captures: [capture('a', '2026-01-05T12:00:00Z', 'filed', 's1'), capture('b', '2026-01-07T11:00:00Z', 'filed', 's1'), capture('c', '2026-01-07T10:00:00Z', 'needs_review', 's2'), capture('old', '2025-12-20T12:00:00Z', 'filed', 's3')],
    decisions: [decision('a', 'applied'), decision('b', 'applied'), decision('c', 'confirmed'), decision('old', 'applied')],
  }
  vi.stubGlobal('useApi', useApi)
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://test.example' } }))
  vi.stubGlobal('useI18n', () => ({ locale: ref('en') }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/captures?')) return fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(page))
    const id = url.split('/').pop()
    return new Response(JSON.stringify({ strand: { id, title: `Synthetic strand ${id}` } }))
  }))
})
afterEach(() => { unmountAll(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Week page', () => {
  it('counts only this week and links the strands it touched', async () => {
    const root = mountNode(WeekPage); await flush()
    const tiles = text(byTestId(root, 'week-tiles')[0]!)
    expect(tiles).toMatch(/week\.tiles\.captures\s+3/)
    expect(tiles).toMatch(/week\.tiles\.strands\s+2/)
    expect(all(byTestId(root, 'week-bars')[0]!).filter(n => n.tag === 'li')).toHaveLength(7)
    const links = all(root).filter(n => n.tag === 'a').map(n => n.props.href)
    expect(links).toEqual(['/strands/s1', '/strands/s2'])
    expect(text(root)).toContain('Synthetic strand s1')
    expect(text(root)).not.toContain('never shown')
  })

  it('W6b: reads the whole week page by page with since, beyond 200 captures, exactly', async () => {
    const many = Array.from({ length: 450 }, (_, i) => capture(`m${i}`, `2026-01-0${5 + (i % 3)}T0${i % 10}:00:00Z`, 'filed', 's1'))
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/captures?')) {
        urls.push(url)
        const q = new URL(url).searchParams
        const offset = Number(q.get('offset'))
        return new Response(JSON.stringify({ captures: many.slice(offset, offset + 200), decisions: [], total: many.length }))
      }
      return new Response(JSON.stringify({ strand: { id: 's1', title: 'Synthetic strand s1' } }))
    }))
    const root = mountNode(WeekPage); await flush()
    expect(urls).toHaveLength(3)
    const q = new URL(urls[0]!).searchParams
    expect(q.get('since')).toBe('2025-12-30T12:00:00.000Z')
    expect(urls.map(u => new URL(u).searchParams.get('offset'))).toEqual(['0', '200', '400'])
    expect(text(byTestId(root, 'week-tiles')[0]!)).toMatch(/week\.tiles\.captures\s+450/)
  })

  it('explains an empty week and points to Home', async () => {
    page = { captures: [], decisions: [] }
    const root = mountNode(WeekPage); await flush()
    expect(text(byTestId(root, 'week-empty')[0]!)).toContain('week.emptyText')
    expect(text(byTestId(root, 'week-claim')[0]!)).toContain('week.claim.none')
  })

  it('shows loading, then an error with a working retry', async () => {
    fail = true
    const root = mountNode(WeekPage)
    expect(byTestId(root, 'skeleton')).toHaveLength(1)
    await flush()
    expect(text(root)).toContain('week.loadError')
    fail = false
    await click(button(root, 'common.retry'))
    expect(byTestId(root, 'week-tiles')).toHaveLength(1)
  })
})
