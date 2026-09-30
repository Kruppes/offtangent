import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref, computed } from 'vue'
import { renderToString } from 'vue/server-renderer'
import BoardDetail from './[key].vue'
import type { Board, BoardRevisionEntry, SeriesPoint } from '~/api/boards'
import { storyReadKey } from '~/utils/newsDigest'

const mocked = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock('~/composables/useBoards', () => ({ useBoardDetail: mocked.detail }))
afterEach(() => vi.unstubAllGlobals())

/**
 * Synthetic `portfolio_digest.v1` payload with every optional block present.
 * Company names and ISINs are invented (`XX…`), the numbers are round.
 */
const fullPayload = {
  schema_version: 'portfolio_digest.v1',
  board_key: 'depot',
  run_id: 'depot-2026-09-25-evening',
  slot: 'evening',
  as_of: '2026-09-25T20:00:00Z',
  market_state: 'closed',
  currency: 'EUR',
  overview: {
    securities_eur: 100000, cash_eur: 25000, total_eur: 125000,
    day: { delta_eur: 1250.5, delta_pct: 1.27 },
    week: { delta_eur: -800, delta_pct: -0.5 },
    month: { delta_eur: 4100, delta_pct: 2.4 },
    ytd: { delta_eur: 21000, delta_pct: 13.3 },
  },
  digest: 'Quiet session with a **late** tech bid.',
  data_issues: [{ severity: 'warn', code: 'unmapped_isin', message: 'Gamma World Fund is missing from the quote map.', isin: 'XX0000000003', value_eur: 2016 }],
  signals: [
    { id: 'sig-1', urgency: 'trim', name: 'Alpha Corp', isin: 'XX0000000001', headline: 'Trim 6k after +9 %', rationale: 'Weight above the target band.', trigger: { type: 'price', op: 'gte', value: 289 }, status: 'new', first_seen: '2026-09-25' },
    { id: 'sig-2', urgency: 'watch', name: 'Beta Industries', isin: 'XX0000000002', headline: 'Watch the 100 € line', status: 'carried', first_seen: '2026-09-22' },
    { id: 'sig-3', urgency: 'teleport', name: 'Delta Mining', isin: 'XX0000000004', headline: 'Unknown urgency stays visible', status: 'new' },
  ],
  movers: {
    gainers: [{ name: 'Alpha Corp', isin: 'XX0000000001', price_eur: 197.44, delta_pct: 4.2, impact_eur: 3489, explanation: 'Sector rebound.' }],
    losers: [{ name: 'Beta Industries', isin: 'XX0000000002', price_eur: 88.1, delta_pct: -2.4, impact_eur: -980, explanation: 'Guidance cut.' }],
  },
  allocation: {
    basis: 'securities_eur',
    positions: [{ name: 'Alpha Corp', isin: 'XX0000000001', weight_pct: 41.7, value_eur: 41700, drift_pp_1w: -0.3 }],
    clusters: [{ label: 'AI / Data centre', weight_pct: 26.1, members: ['Alpha Corp', 'Beta Industries'] }],
  },
  macro: [{ label: 'Index A', value: 25408.64, delta_pct: 0.56 }, { label: 'Vol', value: 15.01, delta_pct: -4.21 }],
  macro_note: 'Risk-on, volatility at a yearly low.',
  news: [
    { name: 'Alpha Corp', isin: 'XX0000000001', title: 'Alpha Corp buys a cooling specialist', publisher: 'Example Wire', url: 'https://news.example.com/alpha', published_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), summary_de: 'Bolt-on strengthens the thesis.' },
    { name: 'Beta Industries', title: 'Beta Industries cuts guidance', publisher: 'Example Wire', url: 'javascript:alert(1)', published_at: '2026-09-25T09:00:00Z' },
  ],
  calendar: [{ name: 'Alpha Corp', event: 'Q3 earnings', date: '2026-11-19', when: 'after_close' }],
  changes_since: { compared_to_run: 'depot-2026-09-25-morning', items: ['New trim signal Alpha Corp'] },
  footer: { sources: ['exchange-a', 'broker-b'], positions_valid: 20, positions_total: 22, cost_eur: 0.05 },
}

const minimalPayload = {
  schema_version: 'portfolio_digest.v1',
  run_id: 'depot-2026-09-26-morning',
  slot: 'morning',
  as_of: '2026-09-26T06:30:00Z',
  overview: { securities_eur: 100000, cash_eur: 25000, total_eur: 125000, day: { delta_eur: -300, delta_pct: -0.24 } },
  digest: 'Flat open.',
}

const board = (overrides: Partial<Board> = {}): Board => ({
  key: 'depot', kind: 'portfolio_digest.v1', title: 'Portfolio', icon: '📈', agentId: 'analyst',
  revision: 7, summary: 'Securities up 1.0 % today.', asOf: '2026-09-25T20:00:00Z',
  updatedAt: '2026-09-25T20:00:03Z', payload: fullPayload, ...overrides,
})

const series: SeriesPoint[] = Array.from({ length: 90 }, (_, index) => ({
  day: `2026-0${index < 30 ? 7 : index < 60 ? 8 : 9}-${String((index % 30) + 1).padStart(2, '0')}`,
  value: 120000 + index * 55,
}))

async function render(state: {
  board?: Board | null
  loading?: boolean
  error?: string
  series?: SeriesPoint[]
  revisions?: BoardRevisionEntry[]
  viewedRevision?: number | null
  historyOpen?: boolean
  query?: Record<string, string>
}) {
  const current = state.board ?? null
  const viewed = ref(state.viewedRevision ?? null)
  mocked.detail.mockReturnValue({
    board: ref(state.board === undefined ? board() : state.board),
    current: ref(current === undefined ? board() : current ?? board()),
    revisions: ref(state.revisions ?? []),
    series: ref(state.series ?? []),
    loading: ref(state.loading ?? false),
    error: ref(state.error ?? null),
    viewedRevision: viewed,
    isHistoric: computed(() => viewed.value !== null),
    historyOpen: ref(state.historyOpen ?? false),
    load: vi.fn(), openRevision: vi.fn(), backToCurrent: vi.fn(),
  })
  vi.stubGlobal('useRoute', () => ({ params: { key: 'depot' }, query: state.query ?? {} }))
  vi.stubGlobal('useRouter', () => ({ push: vi.fn() }))
  vi.stubGlobal('useI18n', () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join('|')}` : key),
  }))
  const app = createSSRApp(BoardDetail)
  app.config.globalProperties.$t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join('|')}` : key) as never
  for (const [name, tag] of Object.entries({ Button: 'button', PageHeader: 'header', Alert: 'section', AlertDescription: 'p' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  app.component('AppIcon', defineComponent({ props: ['name'], setup: props => () => h('i', { class: props.name }) }))
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  return renderToString(app)
}

describe('Board page states', () => {
  it('renders accessible loading skeletons', async () => {
    const html = await render({ board: null, loading: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('animate-pulse')
  })

  it('renders an actionable error instead of an empty board', async () => {
    const html = await render({ board: null, error: 'boards.detailError' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('boards.detailError')
    expect(html).toContain('common.retry')
    expect(html).not.toContain('boards.notFound')
  })

  it('renders the header with as-of, revision and a refresh control', async () => {
    const html = await render({})
    expect(html).toContain('Portfolio')
    expect(html).toContain('boards.asOf:2026-09-25T20:00:00Z')
    expect(html).toContain('boards.revision:7')
    expect(html).toContain('common.refresh')
    expect(html).toContain('href="/boards"')
  })

  it('renders an empty payload without pretending there is content', async () => {
    const html = await render({ board: board({ payload: {} }) })
    expect(html).toContain('boards.emptyPayload')
  })
})

describe('portfolio_digest.v1 renderer', () => {
  it('renders every block of a full payload in the contract order', async () => {
    const html = await render({ board: board(), series })
    const order = ['boards.digest.dataIssues', 'boards.digest.overview', 'boards.digest.text', 'boards.digest.openSignals',
      'boards.digest.todaySignals', 'boards.digest.movers', 'boards.digest.allocation', 'boards.digest.macro',
      'boards.digest.news', 'boards.digest.calendar', 'boards.digest.changes'].map(key => html.indexOf(key))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('formats money and percentages in de-DE with securities and cash apart', async () => {
    const html = await render({ board: board() })
    expect(html).toContain('100.000,00\u00a0€')
    expect(html).toContain('25.000,00\u00a0€')
    expect(html).toContain('+1.250,50\u00a0€')
    expect(html).toContain('+1,27 %')
    expect(html).toContain('boards.digest.cash')
    expect(html).toContain('boards.digest.securities')
  })

  it('draws an inline sparkline polyline from the fetched series', async () => {
    const html = await render({ board: board(), series })
    expect(html).toContain('<polyline')
    // Vue's SSR string renderer lowercases attribute names; the HTML parser and
    // the client-side render function restore the SVG casing of `viewBox`.
    expect(html.toLowerCase()).toContain('viewbox="0 0 100 28"')
    expect(html).toContain('boards.digest.sparklineHint:90')
    // Scales with its box (mobile-first) and stays an accessible image, no chart lib.
    expect(html.toLowerCase()).toContain('preserveaspectratio="none"')
    expect(html).toContain('role="img"')
    expect(html).toContain('stroke="currentColor"')
    const points = /points="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(points.split(' ')).toHaveLength(series.length)
    for (const pair of points.split(' ')) {
      const [x, y] = pair.split(',').map(Number)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(100)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(28)
    }
    expect(await render({ board: board(), series: [] })).not.toContain('<polyline')
    // A single point cannot form a line, so no misleading flat stroke is drawn.
    expect(await render({ board: board(), series: series.slice(0, 1) })).not.toContain('<polyline')
  })

  it('separates carried from new signals and keeps an unknown urgency visible', async () => {
    const html = await render({ board: board() })
    const open = html.indexOf('boards.digest.openSignals')
    const today = html.indexOf('boards.digest.todaySignals')
    expect(html.indexOf('Beta Industries')).toBeGreaterThan(open)
    expect(html.indexOf('Beta Industries')).toBeLessThan(today)
    expect(html).toContain('✂️')
    expect(html).toContain('👀')
    expect(html).toContain('Delta Mining')
  })

  it('links only http(s) news and never shows an ISIN', async () => {
    const html = await render({ board: board() })
    expect(html).toContain('href="https://news.example.com/alpha"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('javascript:alert(1)')
    expect(html).toContain('Beta Industries cuts guidance')
    expect(html).not.toContain('XX00000000')
  })

  it('renders the digest text as markdown', async () => {
    const html = await render({ board: board() })
    expect(html).toContain('<strong>late</strong>')
  })

  it('skips every absent block of a minimal payload', async () => {
    const html = await render({ board: board({ payload: minimalPayload }) })
    expect(html).toContain('boards.digest.overview')
    expect(html).toContain('boards.digest.text')
    expect(html).toContain('Flat open.')
    for (const key of ['boards.digest.dataIssues', 'boards.digest.openSignals', 'boards.digest.todaySignals',
      'boards.digest.movers', 'boards.digest.allocation', 'boards.digest.macro', 'boards.digest.news',
      'boards.digest.calendar', 'boards.digest.changes', 'boards.digest.footer']) {
      expect(html).not.toContain(key)
    }
    expect(html).toContain('-300,00\u00a0€')
  })
})

describe('unknown kinds and history', () => {
  it('falls back to summary markdown plus collapsed raw JSON', async () => {
    const html = await render({
      board: board({ kind: 'price_search.v1', title: 'Price watch', summary: 'Cheapest offer is **19,99 €**.', payload: { query: 'thermal paste', hits: [{ shop: 'Example Shop', price_eur: 19.99 }] } }),
    })
    expect(html).toContain('boards.unknownKind:price_search.v1')
    expect(html).toContain('<strong>19,99 €</strong>')
    expect(html).toContain('boards.rawData')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('&quot;shop&quot;: &quot;Example Shop&quot;')
    expect(html).not.toContain('boards.digest.overview')
    // Raw JSON is pretty-printed, monospace, height-capped and scrollable.
    expect(html).toContain('id="board-raw-json"')
    expect(html).toMatch(/<pre[^>]*class="[^"]*max-h-96[^"]*"/)
    expect(html).toMatch(/<pre[^>]*class="[^"]*overflow-auto[^"]*"/)
    expect(html).toMatch(/<pre[^>]*class="[^"]*font-mono[^"]*"/)
    expect(html).toContain('style="display:none;"')
    expect(html).toContain('\n  &quot;query&quot;: &quot;thermal paste&quot;')
  })

  it('offers the revision history and a read-only banner with a way back', async () => {
    const collapsed = await render({ revisions: [{ revision: 7, asOf: '2026-09-25T20:00:00Z', createdAt: '2026-09-25T20:00:03Z', summary: 'Latest' }] })
    expect(collapsed).toContain('boards.history')
    expect(collapsed).toContain('aria-controls="board-history"')

    const historic = await render({
      board: board({ revision: 6 }),
      revisions: [{ revision: 6, asOf: '2026-09-24T20:00:00Z', createdAt: '2026-09-24T20:00:02Z', summary: 'Older' }],
      viewedRevision: 6, historyOpen: true,
    })
    expect(historic).toContain('boards.historicBanner:6|')
    expect(historic).toContain('boards.backToCurrent')
  })

  it('renders a historic revision with the kind renderer, not the generic fallback', async () => {
    // Exactly the response `GET /api/boards/:key/revisions/:n` serves: the
    // revision's own state plus the identity of its board. A revision without
    // `kind` would silently drop to GenericBoard and lose the header.
    const html = await render({
      board: board({
        revision: 6, summary: 'Older digest.', asOf: '2026-09-24T20:00:00Z',
        payload: { ...fullPayload, run_id: 'depot-2026-09-24-evening', digest: 'Older **quiet** session.' },
      }),
      revisions: [{ revision: 6, asOf: '2026-09-24T20:00:00Z', createdAt: '2026-09-24T20:00:02Z', summary: 'Older' }],
      viewedRevision: 6, historyOpen: true, series,
    })
    expect(html).not.toContain('boards.unknownKind')
    expect(html).toContain('boards.digest.overview')
    expect(html).toContain('<strong>quiet</strong>')
    // The header keeps title, icon and the viewed revision.
    expect(html).toContain('Portfolio')
    expect(html).toContain('📈')
    expect(html).toContain('boards.revision:6')
    expect(html).toContain('boards.asOf:2026-09-24T20:00:00Z')
  })
})

/**
 * News digest renderer (design spec 2026-09-28, contract `news_digest.v2`).
 * Synthetic payload: invented labs, feeds and example.com URLs, one
 * deliberately broken item and one non-https source. These are SSR renders, so
 * they cover the initial markup; clicks and measurements live in the
 * Playwright gate (`/workspace/nd-shots`).
 */
const newsPayload = {
  schema_version: 'news_digest.v2',
  date: '2026-09-28',
  generated_at: '2026-09-28T07:04:00+02:00',
  headline: 'Two model releases and a cheaper speech stack.',
  categories: { frontier: 'Frontier', tts_stt: 'Speech' },
  items: [
    {
      story_id: 'model-3', rank: 1, status: 'update', delta: 'The licence now allows commercial use.',
      title: 'Example Lab releases model 3', category: 'frontier', verdict: 'hot',
      take: 'Real progress on context, but the pricing page hides the rate limits.',
      score: 82, summary: 'A longer context window and a lower price.',
      critique: 'The benchmark table only compares against its own predecessor.',
      relevance: 'Worth a day on the agent loop.',
      action: { kind: 'try', text: 'Run the coding loop against it.' },
      source_count: 3, tags: ['models'],
      sources: [
        { name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary', published_at: '2026-09-27' },
        { name: 'Example Wire', url: 'https://news.example.com/a', type: 'press', published_at: '2026-09-28' },
        { name: 'Insecure Feed', url: 'http://insecure.example.com/a', type: 'aggregator' },
      ],
    },
    {
      story_id: 'speech-1', rank: 2, status: 'new', title: 'Cheaper speech stack', category: 'tts_stt', verdict: 'watch',
      take: 'Cheap, but every source is a reseller.',
      summary: 'A speech model at a third of the price.',
      sources: [{ name: 'Example Vendor', url: 'https://vendor.example.com/pricing', type: 'press' }],
    },
    { story_id: 'broken', verdict: 'hype', sources: [] },
  ],
  quick_hits: [
    { title: 'Example toolkit 2.0', url: 'https://example.org/toolkit', source: 'Example Org', note: 'Minor release.' },
    { title: 'Unlinkable hit', url: 'javascript:alert(1)', source: 'Example Org' },
  ],
  stats: { sources_checked: 31, sources_failed: ['Example Feed'], candidates: 191 },
}

const newsRevisions: BoardRevisionEntry[] = [
  { revision: 9, asOf: '2026-09-28T05:04:00Z', createdAt: '2026-09-28T05:04:02Z', summary: 'Two model releases and a cheaper speech stack.' },
  { revision: 8, asOf: '2026-09-27T05:02:00Z', createdAt: '2026-09-27T05:02:03Z', summary: 'A quiet Sunday.' },
]

const newsBoard = (payload: unknown = newsPayload, kind = 'news_digest.v2') =>
  board({ key: 'ai-news', kind, title: 'AI news', icon: '📰', payload })

describe('news digest renderer', () => {
  it('renders day line, headline, counter line, list, quick hits and footer', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).not.toContain('boards.unknownKind')
    expect(html).toContain('Two model releases and a cheaper speech stack.')
    // Day line with the formatted day of the loaded payload.
    expect(html).toContain('28 Sep 2026')
    expect(html).toContain('boards.news.itemCount:2')
    expect(html).toContain('boards.news.hotCount:1')
    expect(html).toContain('boards.news.updatedAt:')
    expect(html).toContain('Example Lab releases model 3')
    expect(html).toContain('Real progress on context, but the pricing page hides the rate limits.')
    expect(html).toContain('boards.news.quickHits')
    expect(html).toContain('boards.news.checkedSources:31')
    expect(html).toContain('boards.news.sourcesFailedOne')
    // List order follows `rank`.
    expect(html.indexOf('Example Lab releases model 3')).toBeLessThan(html.indexOf('Cheaper speech stack'))
  })

  it('has no cards, no filter chips and no disclosure in the list', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).not.toContain('boards.news.filterAll')
    expect(html).not.toContain('aria-pressed')
    expect(html).not.toContain('boards.news.details')
    expect(html).not.toContain('news-details-')
  })

  it('keeps summary, critique and relevance out of the list DOM', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).not.toContain('A longer context window and a lower price.')
    expect(html).not.toContain('The benchmark table only compares against its own predecessor.')
    expect(html).not.toContain('Worth a day on the agent loop.')
    expect(html).not.toContain('boards.news.criticalTake')
  })

  it('shows rank, verdict pill, category label from the payload and the update marker', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).toContain('>01<')
    expect(html).toContain('>02<')
    expect(html).toContain('boards.news.verdict.hot')
    expect(html).toContain('boards.news.verdict.watch')
    expect(html).toContain('Frontier')
    expect(html).toContain('Speech')
    expect(html).toContain('boards.news.update')
    // Verdict pill shapes: filled signal for hot, outline for watch.
    expect(html).toContain('nd-signal')
    expect(html).toContain('nd-outline-t2')
  })

  it('counts sources and warns when a story has no firsthand source', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).toContain('boards.news.sourceCount:3')
    expect(html).toContain('boards.news.firsthandCount:1')
    expect(html).toContain('boards.news.sourceOne')
    expect(html).toContain('boards.news.noFirsthand')
  })

  it('opens one story as route state with its sections in the design order', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions, query: { date: '2026-09-28', story: 'model-3' } })
    expect(html).toContain('boards.news.position:1|2')
    // Measure inside the detail article: the list footer also mentions sources.
    const detail = html.slice(html.indexOf('boards.news.position'))
    const order = ['boards.news.whatsNew', 'boards.news.whatHappened', 'boards.news.criticalTake',
      'boards.news.forUs', 'boards.news.nextStep', 'boards.news.sources', 'boards.news.nextStoryLabel'].map(key => detail.indexOf(key))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('The licence now allows commercial use.')
    expect(html).toContain('A longer context window and a lower price.')
    expect(html).toContain('boards.news.action.try')
    expect(html).toContain('boards.news.sourceType.primary')
    // Next story teaser carries the following title.
    expect(html).toContain('Cheaper speech stack')
  })

  it('lists firsthand sources first and shows their date', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions, query: { story: 'model-3' } })
    const detail = html.slice(html.indexOf('boards.news.sources'))
    expect(detail.indexOf('Example Lab blog')).toBeLessThan(detail.indexOf('Example Wire'))
    expect(html).toContain('27\u00a0Sep')
  })

  /**
   * Own payload so the shared fixture keeps its counts: one story with several
   * sources and not a single firsthand one, and a host with two dots.
   */
  const rumourPayload = {
    ...newsPayload,
    items: [{
      story_id: 'rumour-1', rank: 1, status: 'new', title: 'Takeover rumour around a speech vendor',
      category: 'tts_stt', verdict: 'relevant',
      take: 'Only secondary sources, no confirmation anywhere.',
      summary: 'Two papers report a takeover, the vendor says nothing.',
      critique: 'Nobody names a source.',
      sources: [
        { name: 'Example Wire', url: 'https://news.example.com/rumour', type: 'press', published_at: '2026-09-28' },
        { name: 'Example Daily', url: 'https://business.example.com/rumour', type: 'press', published_at: '2026-09-28' },
        { name: 'Example Aggregator', url: 'https://aggregator.example.net/rumour', type: 'aggregator', published_at: '2026-09-28' },
      ],
    }],
  }

  /**
   * SSR markup without the scope attribute and without any comment. Which
   * comments Vue emits depends on NODE_ENV (the image build runs with `test`,
   * which keeps `<!--v-if-->` and template comments), and none of them is
   * text the reader sees.
   */
  const plain = (value: string) => value.replace(/ data-v-[0-9a-f]+/g, '').replace(/<!--[\s\S]*?-->/g, '')

  it('repeats the missing firsthand source as the first line inside the detail sources section', async () => {
    const html = plain(await render({ board: newsBoard(rumourPayload), revisions: newsRevisions, query: { story: 'rumour-1' } }))
    const detail = html.slice(html.indexOf('boards.news.sources<'))
    const heading = detail.indexOf('boards.news.sources<')
    const warning = detail.indexOf('boards.news.noFirsthand')
    const list = detail.indexOf('<ul')
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(warning).toBeGreaterThan(heading)
    expect(warning).toBeLessThan(list)
    // Same sentence as the list row: "3 sources · " text-2 400 plus the warning in text-1 600.
    const line = detail.slice(heading, list)
    expect(line).toContain('boards.news.sourceCount:3')
    expect(line).toContain('class="nd-meta nd-t2 mt-[8px]"')
    expect(line).toContain('<span class="nd-t1 nd-strong">boards.news.noFirsthand</span>')
    // No icon, no tinted surface, no border, no extra colour in that line.
    expect(line).not.toContain('<i')
    expect(line).not.toContain('svg')
    expect(line).not.toContain('nd-raised')
    expect(line).not.toContain('nd-signal')
    expect(line).not.toContain('border')
  })

  it('leaves the line out when the story has a firsthand source', async () => {
    const html = plain(await render({ board: newsBoard(), revisions: newsRevisions, query: { story: 'model-3' } }))
    const detail = html.slice(html.indexOf('boards.news.sources<'))
    const line = detail.slice(0, detail.indexOf('<ul'))
    expect(line).not.toContain('boards.news.noFirsthand')
    expect(detail).toContain('boards.news.sourceType.primary')
  })

  it('offers a break before every dot of a host name in the source meta line', async () => {
    const html = plain(await render({ board: newsBoard(rumourPayload), revisions: newsRevisions, query: { story: 'rumour-1' } }))
    const detail = html.slice(html.indexOf('boards.news.sources<'))
    // Break before the dot: a dot at a line end reads as the end of a sentence,
    // a dot at a line start reads as a continuation (".net").
    expect(detail).toContain('aggregator<wbr>.example<wbr>.net')
    expect(detail).toContain('news<wbr>.example<wbr>.com')
    // The name of the source keeps its dots as they are, only the host is cut.
    expect(detail).toContain('Example Aggregator')
    // The net below the break opportunities stays.
    expect(detail).toContain('nd-wrap')
  })

  /**
   * Own payload again: a host whose label carries a hyphen, and a source name
   * that is language ("Landesrundfunkanstalt Mitteldeutschland").
   */
  const hyphenPayload = {
    ...newsPayload,
    items: [{
      story_id: 'hyphen-1', rank: 1, status: 'new', title: 'A broadcaster rebuilds its speech stack',
      category: 'tts_stt', verdict: 'relevant', take: 'One long identifier, one long name.',
      summary: 'The broadcaster describes the rebuild.',
      sources: [
        { name: 'Landesrundfunkanstalt Mitteldeutschland', url: 'https://nachrichten.landesrundfunkanstalt-mitteldeutschland.de/beitrag', type: 'press', published_at: '2026-09-27' },
      ],
    }],
  }

  it('breaks a host before its hyphen and locks the joint behind it', async () => {
    const html = plain(await render({ board: newsBoard(hyphenPayload), revisions: newsRevisions, query: { story: 'hyphen-1' } }))
    const detail = html.slice(html.indexOf('boards.news.sources<'))
    // Rank 2 of the identifier rule: break BEFORE the hyphen, never after it, so
    // the hyphen starts the next line instead of reading as a hyphenation mark.
    expect(detail).toContain('nachrichten<wbr>.landesrundfunkanstalt<wbr><span class="nd-nobr">-m</span>itteldeutschland<wbr>.de')
    // An identifier never gets an automatic hyphen, even where the engine has
    // German patterns and an ancestor would otherwise pass hyphens:auto down.
    expect(detail).toMatch(/<span class="[^"]*\bnd-id\b[^"]*">boards\.news\.sourceType\.press\u00a0· nachrichten/)
    // The host itself carries no invisible character: a copy yields it unchanged.
    const meta = detail.slice(detail.indexOf('nachrichten<wbr>'))
    const hostText = meta.slice(0, meta.indexOf('\u00a0')).replace(/<[^>]+>/g, '')
    expect(hostText).toBe('nachrichten.landesrundfunkanstalt-mitteldeutschland.de')
    expect(detail).not.toMatch(/[\u2060\u2011\u200b\u00ad]/)
  })

  it('never lets the "·" of a meta line start a line', async () => {
    const hyphen = plain(await render({ board: newsBoard(hyphenPayload), revisions: newsRevisions, query: { story: 'hyphen-1' } }))
    const meta = hyphen.slice(hyphen.indexOf('boards.news.sources<'))
    // No-break space in front of the separator, a normal one behind it.
    expect(meta).toContain('boards.news.sourceType.press\u00a0· nachrichten')
    expect(meta).toContain('\u00a0· 27\u00a0Sep')
    // Same in the warning line of the section and in the source line of the list.
    const html = plain(await render({ board: newsBoard(rumourPayload), revisions: newsRevisions, query: { story: 'rumour-1' } }))
    expect(html.slice(html.indexOf('boards.news.sources<'))).toContain('boards.news.sourceCount:3\u00a0·')
    const list = plain(await render({ board: newsBoard(rumourPayload), revisions: newsRevisions }))
    expect(list).toContain('boards.news.sourceCount:3\u00a0·')
    // Nowhere a plain space directly in front of a separator any more.
    expect(list).not.toContain(' · ')
    expect(html).not.toContain(' · ')
  })

  it('hyphenates the name of a source as language', async () => {
    const html = plain(await render({ board: newsBoard(hyphenPayload), revisions: newsRevisions, query: { story: 'hyphen-1' } }))
    const detail = html.slice(html.indexOf('boards.news.sources<'))
    expect(detail).toContain('<span class="nd-body nd-t1 nd-de block" lang="de">Landesrundfunkanstalt Mitteldeutschland</span>')
    // The name is language, so it must not get the markless emergency break.
    expect(detail).not.toContain('nd-body nd-t1 nd-wrap')
  })

  it('links only https sources and never a javascript: URL', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions, query: { story: 'model-3' } })
    expect(html).toContain('href="https://example.com/post"')
    expect(html).toContain('href="https://example.org/toolkit"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    expect(html).not.toContain('href="http://insecure.example.com/a"')
    expect(html).not.toContain('javascript:alert(1)')
    expect(html).toContain('Insecure Feed')
    expect(html).toContain('Unlinkable hit')
  })

  it('renders a v1 revision through the same renderer, without a take', async () => {
    const v1 = {
      schema_version: 'news_digest.v1', date: '2026-09-27', headline: 'A quiet Sunday.',
      items: [{ id: 'old-1', rank: 1, title: 'Example Lab ships a patch', category: 'tooling', verdict: 'relevant',
        summary: 'Bug fixes only.', sources: [{ name: 'Example Lab blog', url: 'https://example.com/patch', type: 'primary' }] }],
      stats: { sources_checked: 28 },
    }
    const html = await render({ board: newsBoard(v1, 'news_digest.v1'), revisions: newsRevisions })
    expect(html).not.toContain('boards.unknownKind')
    expect(html).toContain('Example Lab ships a patch')
    // v1 has no take line and no invented substitute from the summary.
    expect(html).not.toContain('Bug fixes only.')
    // Category label falls back to the v1 label table.
    expect(html).toContain('Tooling')
  })

  it('offers the way back when an older day is open', async () => {
    const older = { ...newsPayload, date: '2026-09-27' }
    const html = await render({ board: newsBoard(older), revisions: newsRevisions })
    expect(html).toContain('boards.news.archive')
    expect(html).toContain('boards.news.backToToday')
    expect(html).toContain('?date=2026-09-28')
  })

  it('skips a broken item instead of failing the page', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).toContain('boards.news.itemCount:2')
    expect(html).not.toContain('story=broken')
  })

  /**
   * Read state (review condition, 2026-09-28): the key is story id *plus* last
   * change, so an update with a delta is unread again. Grey = `nd-t2`
   * (text-2), unread = `nd-t1` (text-1); the title of the story under test is
   * the only `nd-title` in the list markup of this fixture pair.
   */
  const titleClass = (html: string, title: string) => {
    const index = html.indexOf(title)
    const start = html.lastIndexOf('<span', index)
    const tag = html.slice(start, index)
    // Guard against a vacuous assertion: this must be the title span.
    expect(tag).toContain('nd-title')
    return tag
  }
  const readStorage = (entries: string[]) => {
    const data = new Map<string, string>([['boards.news.read', JSON.stringify(entries)]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
  }

  it('greys a read story out and brings it back to text-1 as an update', async () => {
    const unchanged = { ...newsPayload, items: [{ ...newsPayload.items[0], status: 'new', delta: undefined }, ...newsPayload.items.slice(1)] }

    // Nothing read yet: the title is text-1.
    readStorage([])
    expect(titleClass(await render({ board: newsBoard(unchanged), revisions: newsRevisions }), 'Example Lab releases model 3')).toContain('nd-t1')

    // Read in its unchanged state: grey.
    readStorage([storyReadKey({ storyId: 'model-3', status: 'new' })])
    expect(titleClass(await render({ board: newsBoard(unchanged), revisions: newsRevisions }), 'Example Lab releases model 3')).toContain('nd-t2')

    // Same story id, now an update with a delta: text-1 again.
    const updatedHtml = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(titleClass(updatedHtml, 'Example Lab releases model 3')).toContain('nd-t1')

    // After opening that state it is grey again.
    readStorage([
      storyReadKey({ storyId: 'model-3', status: 'new' }),
      storyReadKey({ storyId: 'model-3', status: 'update', delta: 'The licence now allows commercial use.' }),
    ])
    expect(titleClass(await render({ board: newsBoard(), revisions: newsRevisions }), 'Example Lab releases model 3')).toContain('nd-t2')
  })

  /**
   * "Use in question" belongs to the open story, not to the list: it is the
   * one action that carries a single article into a conversation.
   */
  it('offers "Use in question" and the copy fallback on an open story only', async () => {
    const list = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(list).not.toContain('news-use-in-question')

    const detail = await render({ board: newsBoard(), revisions: newsRevisions, query: { story: 'model-3' } })
    expect(detail).toContain('data-testid="news-use-in-question"')
    expect(detail).toContain('boards.news.useInQuestion')
    expect(detail).toContain('data-testid="news-copy-context"')
    expect(detail).toContain('boards.news.copyContext')
    // The hint says that nothing is sent before the reader has a question.
    expect(detail).toContain('boards.news.useInQuestionHint')
  })

  it('renders the empty state when a digest has no story', async () => {
    const html = await render({ board: newsBoard({ schema_version: 'news_digest.v2', headline: 'Quiet day.', items: [], stats: { sources_checked: 31 } }) })
    expect(html).toContain('boards.news.empty')
    expect(html).toContain('Quiet day.')
    expect(html).toContain('role="status"')
  })

  it('falls back to the generic renderer when nothing is renderable', async () => {
    const html = await render({ board: newsBoard({ items: [{ story_id: 'x' }] }) })
    expect(html).toContain('boards.unknownKind:news_digest.v2')
    expect(html).toContain('boards.rawData')
  })

  it('shows the board error inside the renderer, with a retry', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions, error: 'boards.detailError' })
    expect(html).toContain('boards.news.loadError')
    expect(html).toContain('boards.news.retry')
  })

  it('gives every tappable element a 48 px target', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions, query: { story: 'model-3' } })
    const links = html.match(/<a [^>]*href="https:\/\/[^"]*"[^>]*>/g) ?? []
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link).toMatch(/min-h-\[(48|56)px\]|py-\[12px\]/)
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) expect(button).toContain('min-h-[48px]')
  })

  it('marks the content German and the interface English', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions })
    expect(html).toContain('lang="en"')
    expect(html).toContain('lang="de"')
    expect(html).toContain('nd-de')
  })

  it('hyphenates every German text block instead of letting a compound overflow', async () => {
    const html = await render({ board: newsBoard(), revisions: newsRevisions, query: { story: 'model-3' } })
    // Every element that carries German content carries the hyphenation class,
    // and no German block is left to break the layout with a long compound.
    const german = html.match(/<[a-z0-9]+ [^>]*lang="de"[^>]*>/g) ?? []
    expect(german.length).toBeGreaterThan(3)
    for (const element of german) expect(element).toContain('nd-de')
  })
})

/**
 * Renderer priority on the board page: a built-in renderer wins, then a
 * server rendered document (`content.url`, any kind), then the generic
 * summary + raw payload fallback. This is what makes a NEW board kind work
 * without a client update: the server ships the renderer, the page only
 * provides the sandboxed frame.
 */
describe('sandboxed document frame', () => {
  const content = (url = '/api/boards/demo/content?t=b1.demo.0.1.9999999999.sig') => ({
    url,
    expiresAt: '2099-01-01T00:00:00Z',
    embed: {
      iframeSandbox: 'allow-scripts',
      iframeReferrerPolicy: 'no-referrer',
      separateOrigin: false,
      denies: ['same-origin', 'cookies', 'localStorage', 'network', 'top-navigation'],
    },
    supportsTheme: true,
    aspectRatio: null,
    minHeightPx: null,
  })

  it('frames an unknown kind that the server renders', async () => {
    const html = await render({
      board: board({ key: 'demo', kind: 'demo_list.v1', title: 'Demo list', payload: { items: [] }, content: content() }),
    })
    expect(html).toContain('<iframe')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain('/api/boards/demo/content')
    // The generic fallback must not be used for a board the server renders.
    expect(html).not.toContain('boards.unknownKind:demo_list.v1')
    expect(html).not.toContain('id="board-raw-json"')
  })

  it('frames an html_view board through the very same component', async () => {
    const html = await render({
      board: board({ key: 'demo', kind: 'html_view.v1', title: 'Wheel', payload: { html: '<p>x</p>' }, content: content() }),
    })
    expect(html).toContain('<iframe')
    expect(html).toContain('boards.htmlView.fullscreen')
  })

  it('keeps the built-in renderer when one exists, even with a server document', async () => {
    const html = await render({
      board: board({ key: 'ki-news', kind: 'news_digest.v2', title: 'News', payload: newsPayload, content: content('/api/boards/ki-news/content?t=b1.ki-news.0.1.9999999999.sig') }),
      revisions: newsRevisions,
    })
    expect(html).not.toContain('<iframe')
    expect(html).toContain('nd-de')
  })

  it('falls back to the generic renderer when the board has no document', async () => {
    const html = await render({
      board: board({ key: 'demo', kind: 'demo_list.v1', title: 'Demo list', summary: 'Nothing to frame.', payload: { items: [] } }),
    })
    expect(html).not.toContain('<iframe')
    expect(html).toContain('boards.unknownKind:demo_list.v1')
  })
})
