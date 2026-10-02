import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApi } from '~/composables/useApi'
import * as captures from '~/api/captures'
import * as now from '~/api/now'
import * as captureParts from '~/features/capture/captureParts'
import { all, APP_DIR, button, byTestId, click, flush, input, loadSfc, mountNode, submit, text, unmountAll } from '~/features/testing/nodeRenderer'
import path from 'node:path'

const UnsortedPage = loadSfc(path.join(APP_DIR, 'features/unsorted/UnsortedPage.vue'), { '~/api/captures': captures, '~/api/now': now, '~/features/capture/captureParts': captureParts, '../captureParts': captureParts })

type Status = 'unsorted' | 'needs_review' | 'failed' | 'filed' | 'dismissed'
const capture = (id: string, status: Status, createdAt = '2026-01-01T12:00:00Z') => ({ id, text: `Synthetic note ${id}`, createdAt, status, strandId: null, attachments: [] })
const decision = (captureId: string, extra: Record<string, unknown> = {}) => ({ id: `d-${captureId}`, createdAt: '2026-01-01T12:00:01Z', captureId, title: 'Proposed topic', action: 'new_strand', confidence: 0.3, rationale: 'Unsure', state: 'proposed', alternatives: [], ...extra })
let pages: Record<string, { captures: unknown[]; decisions: unknown[]; parts?: Record<string, unknown> }>
let failList = false
let request: ReturnType<typeof vi.fn>
const calls = (suffix: string) => request.mock.calls.filter(([url]) => String(url).includes(suffix))

beforeEach(() => {
  failList = false
  pages = { unsorted: { captures: [capture('c1', 'unsorted')], decisions: [decision('c1')] } }
  vi.stubGlobal('useApi', useApi)
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://test.example' } }))
  request = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('https://test.example', '')
    let data: unknown = {}
    if (path.startsWith('/api/captures?')) {
      if (failList) return new Response('{"error":"down"}', { status: 500 })
      const status = new URL(url).searchParams.get('status')!
      data = pages[status] ?? { captures: [], decisions: [] }
    } else if (path.startsWith('/api/strands?')) data = { strands: [{ id: 's2', title: 'House' }] }
    else if (path.startsWith('/api/strands/')) data = { strand: { id: path.split('/').pop(), title: 'Resolved destination' } }
    else if (/\/api\/captures\/[^/]+\/(apply|undo|dismiss|keep-as-one)$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[3]!)
      const action = path.split('/').pop()
      const state: Status = action === 'undo' ? 'unsorted' : action === 'dismiss' ? 'dismissed' : 'filed'
      if (action !== 'undo' && !String(options?.body).includes('partIndex')) pages = {}
      data = { capture: { ...capture(id, state), strandId: state === 'filed' ? 's2' : null }, decision: decision(id, { state: state === 'filed' ? 'applied' : 'proposed' }), body: options?.body }
    }
    return new Response(JSON.stringify(data))
  })
  vi.stubGlobal('fetch', request)
})
afterEach(() => { unmountAll(); vi.unstubAllGlobals() })

describe('Unsorted page', () => {
  it('shows loading, then an error with a working retry, then the list', async () => {
    failList = true
    const root = mountNode(UnsortedPage)
    expect(byTestId(root, 'skeleton')).toHaveLength(1)
    await flush()
    expect(text(root)).toContain('unsorted.loadError')
    failList = false
    await click(button(root, 'common.retry'))
    expect(text(root)).toContain('unsorted.count:1')
    expect(text(root)).toContain('Synthetic note c1')
  })

  it('explains an empty tray and links back to Home', async () => {
    pages = {}
    const root = mountNode(UnsortedPage); await flush()
    const empty = byTestId(root, 'unsorted-empty')[0]!
    expect(text(empty)).toContain('unsorted.emptyTitle')
    expect(text(empty)).toContain('unsorted.emptyText')
    expect(all(empty).some(n => n.tag === 'a' && n.props.href === '/')).toBe(true)
  })

  it('resolves an append proposal outside the candidate list by decision.strandId', async () => {
    pages = { unsorted: { captures: [capture('c1', 'unsorted')], decisions: [decision('c1', { action: 'append', strandId: 'outside', title: null })] } }
    const root = mountNode(UnsortedPage); await flush()
    expect(text(root)).toContain('Resolved destination')
    expect(calls('/api/strands/outside')).toHaveLength(1)
  })

  it('manually files an unsorted capture into a new named strand and keeps the undo', async () => {
    const root = mountNode(UnsortedPage); await flush()
    await input(all(root).find(n => n.tag === 'input' && n.props.type === 'text')!, 'Better destination')
    await submit(all(root).filter(n => n.tag === 'form').at(-1)!)
    expect(JSON.parse(calls('/apply')[0]![1].body)).toEqual({ decisionId: 'd-c1', action: 'new_strand', title: 'Better destination' })
    expect(text(root)).toContain('unsorted.applied')
    expect(byTestId(root, 'unsorted-last')).toHaveLength(1)
    expect(text(root)).toContain('unsorted.emptyTitle')
    await click(button(byTestId(root, 'unsorted-last')[0]!, 'capture.undo'))
    expect(calls('/undo')[0]![1].body).toBe('{}')
    expect(text(root)).toContain('unsorted.undone')
  })

  it('discards a card with an undo path', async () => {
    const root = mountNode(UnsortedPage); await flush()
    await click(button(root, 'capture.discard'))
    expect(calls('/dismiss')).toHaveLength(1)
    expect(text(root)).toContain('capture.discarded')
    expect(byTestId(root, 'unsorted-last')).toHaveLength(1)
  })

  it('decides a split capture per part, shows the original part and keeps it as one', async () => {
    const parts = [
      { index: 0, title: 'Garden', text: 'Water the synthetic plants.', sentenceIds: [1], decision: decision('c1', { id: 'p0', strandId: 's2', action: 'append' }) },
      { index: 1, title: 'Errands', text: 'Buy synthetic stamps.', sentenceIds: [2, 3], decision: decision('c1', { id: 'p1' }) },
    ]
    pages = { unsorted: { captures: [capture('c1', 'unsorted')], decisions: [decision('c1')], parts: { c1: parts } } }
    const root = mountNode(UnsortedPage); await flush()
    expect(byTestId(root, 'capture-part')).toHaveLength(2)
    const second = byTestId(root, 'capture-part')[1]!
    await click(byTestId(second, 'part-original')[0]!)
    expect(text(root)).toContain('unsorted.original.part')
    expect(text(root)).toContain('Buy synthetic stamps.')
    await click(button(byTestId(root, 'capture-part')[1]!, 'home.parts.keep'))
    expect(JSON.parse(calls('/apply')[0]![1].body)).toEqual({ decisionId: 'p1', partIndex: 1 })
    expect(text(root)).toContain('home.parts.kept')
    await click(button(root, 'home.parts.keepAsOne'))
    expect(calls('/keep-as-one')).toHaveLength(1)
    expect(text(root)).toContain('home.parts.keptAsOne')
  })
})
