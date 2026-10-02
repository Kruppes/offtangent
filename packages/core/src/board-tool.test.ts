/**
 * `publish_board`: validation, limits, dedupe and the rule that the tool
 * NEVER throws — a publishing cronjob has to read the reason, not a stack.
 *
 * Fixtures are synthetic throughout ("Alpha Corp", XX0000000001).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { getBoard, getBoardSeries, listBoardRevisions } from './board-store.js'
import {
  createPublishBoardTool,
  validateBoardParams,
  validatePortfolioDigestPayload,
  type BoardPublication,
} from './board-tool.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

const digestPayload = {
  schema_version: 'portfolio_digest.v1',
  run_id: 'run-2026-09-25-evening',
  slot: 'evening',
  as_of: '2026-09-25T20:00:00Z',
  overview: {
    securities_eur: 1000,
    cash_eur: 250,
    total_eur: 1250,
    day: { delta_eur: 12.5, delta_pct: 1.01 },
  },
  digest: 'Alpha Corp up, Beta Industries flat.',
}

function tool(overrides: Partial<Parameters<typeof createPublishBoardTool>[0]> = {}) {
  const published: BoardPublication[] = []
  const feedItems = new Map<string, string>()
  const instance = createPublishBoardTool({
    db,
    getCurrentToolUserId: () => 1,
    getCurrentAgentId: () => 'main',
    publish: (publication) => {
      published.push(publication)
      const key = publication.dedupeKey
      if (key && feedItems.has(key)) return { feedItemId: feedItems.get(key)!, deduped: true, notified: false }
      const id = `feed-${published.length}`
      if (key) feedItems.set(key, id)
      return { feedItemId: id, deduped: false, notified: publication.notify }
    },
    ...overrides,
  })
  return { instance, published }
}

async function run(instance: ReturnType<typeof createPublishBoardTool>, params: Record<string, unknown>) {
  return await instance.execute('call-1', params as never, {} as never) as {
    content: { type: string; text: string }[]
    isError?: boolean
    details?: Record<string, unknown>
  }
}

const valid = {
  key: 'portfolio',
  kind: 'portfolio_digest.v1',
  title: 'Portfolio',
  summary: 'Up 1.0% today.',
  payload: digestPayload,
}

describe('publish_board', () => {
  it('tells the model where the user finds boards: the Boards card', () => {
    const { instance } = tool()
    expect(instance.description).toContain('opens from the "Boards" card')
    expect(instance.description).not.toMatch(/integration/i)
  })

  it('writes the board, the revision and the feed publication', async () => {
    const { instance, published } = tool()
    const result = await run(instance, { ...valid, icon: '📈', as_of: '2026-09-25T20:00:00Z' })

    expect(result.isError).toBeUndefined()
    expect(result.details).toMatchObject({ key: 'portfolio', revision: 1, feedItemId: 'feed-1', deduped: false })

    const board = getBoard(db, '1', 'portfolio')!
    expect(board).toMatchObject({
      kind: 'portfolio_digest.v1', title: 'Portfolio', icon: '📈', agentId: 'main', revision: 1,
      summary: 'Up 1.0% today.', asOf: '2026-09-25T20:00:00Z',
    })
    expect(board.payload).toEqual(digestPayload)
    expect(published[0]).toMatchObject({
      userId: 1, key: 'portfolio', title: 'Portfolio', revision: 1, notify: false, dedupeKey: null,
    })
  })

  it('stores series points and reports them', async () => {
    const { instance } = tool()
    const result = await run(instance, {
      ...valid,
      series: [
        { series: 'total_eur', day: '2026-09-24', value: 1237.5 },
        { series: 'total_eur', day: '2026-09-25', value: 1250, meta: { name: 'Alpha Corp' } },
      ],
    })
    expect(result.content[0]!.text).toContain('2 series point(s) stored')
    const stored = db.prepare('SELECT series, day, value FROM board_series ORDER BY day').all()
    expect(stored).toEqual([
      { series: 'total_eur', day: '2026-09-24', value: 1237.5 },
      { series: 'total_eur', day: '2026-09-25', value: 1250 },
    ])
    expect(getBoardSeries(db, '1', 'portfolio', ['total_eur'], 400).total_eur).toHaveLength(0 + stored.length)
  })

  it('updates the board on a repeated dedupe_key but produces no second feed item', async () => {
    const { instance, published } = tool()
    const first = await run(instance, { ...valid, dedupe_key: 'run-42' })
    const second = await run(instance, {
      ...valid, dedupe_key: 'run-42', summary: 'Corrected: up 0.9% today.',
    })

    expect(first.details).toMatchObject({ revision: 1, deduped: false })
    expect(second.details).toMatchObject({ revision: 2, deduped: true, feedItemId: 'feed-1' })
    expect(second.content[0]!.text).toContain('no new feed card')
    // The board IS updated on the deduped publish — that is the whole point.
    expect(getBoard(db, '1', 'portfolio')!.summary).toBe('Corrected: up 0.9% today.')
    expect(listBoardRevisions(db, '1', 'portfolio').map(r => r.revision)).toEqual([2, 1])
    expect(published).toHaveLength(2)
  })

  it('refuses to publish without a user context instead of guessing one', async () => {
    const { instance } = tool({ getCurrentToolUserId: () => undefined })
    const result = await run(instance, valid)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('needs a user context')
    expect(db.prepare('SELECT COUNT(*) AS c FROM boards').get()).toEqual({ c: 0 })
  })

  it('reports a failing announcement without inviting a second publish', async () => {
    const { instance } = tool({
      publish: () => { throw new Error('feed is down') },
    })
    const result = await run(instance, valid)
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toContain('announcing it failed: feed is down')
    expect(result.details).toMatchObject({ revision: 1, announceFailed: true })
    expect(getBoard(db, '1', 'portfolio')!.revision).toBe(1)
  })

  it('returns every validation failure as a tool error, never as a throw', async () => {
    const { instance } = tool()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...valid, key: 'Portfolio' }, 'key must match'],
      [{ ...valid, key: 'a' }, 'key must match'],
      [{ ...valid, kind: 'portfolio' }, 'kind must match'],
      [{ ...valid, title: '   ' }, 'title must not be empty'],
      [{ ...valid, title: 'x'.repeat(81) }, 'at most 80 characters'],
      [{ ...valid, summary: 'x'.repeat(2001) }, 'at most 2000 characters'],
      [{ ...valid, payload: 'not an object' }, 'payload is required'],
      [{ ...valid, as_of: 'yesterday' }, 'as_of must be an ISO 8601 timestamp'],
      [{ ...valid, notify: 'yes' }, 'notify must be a boolean'],
      [{ ...valid, series: [{ series: 'x', day: '25.09.2026', value: 1 }] }, 'YYYY-MM-DD'],
      [{ ...valid, series: [{ series: 'x', day: '2026-09-25', value: 'a lot' }] }, 'finite number'],
      [{ ...valid, series: Array.from({ length: 501 }, () => ({ series: 'x', day: '2026-09-25', value: 1 })) }, 'at most 500 entries'],
    ]
    for (const [params, expected] of cases) {
      const result = await run(instance, params)
      expect(result.isError, JSON.stringify(expected)).toBe(true)
      expect(result.content[0]!.text).toContain(expected)
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM boards').get()).toEqual({ c: 0 })
  })

  // Regression: the first live run (26.09.) sent `payload` as a JSON string because the schema
  // declared it as `any`; the model has no way to know it must be an object. Accept the string
  // form as long as it decodes to a plain object, so a well-formed digest is never lost.
  it('accepts payload and series.meta as JSON strings that decode to an object', async () => {
    const { instance } = tool()
    const payload = digestPayload
    const result = await run(instance, {
      ...valid,
      payload: JSON.stringify(payload, null, 2),
      series: [{ series: 'total_eur', day: '2026-09-26', value: 2, meta: '{"source":"probe"}' }],
    })
    expect(result.isError).toBeFalsy()
    expect(getBoard(db, '1', 'portfolio')?.payload).toEqual(payload)
    expect(getBoardSeries(db, '1', 'portfolio', ['total_eur'], 400).total_eur[0]?.meta).toEqual({ source: 'probe' })
  })

  it('rejects payload strings that are not a JSON object', async () => {
    const { instance } = tool()
    for (const payload of ['[1,2]', '"text"', '42', '{not json', 'null']) {
      const result = await run(instance, { ...valid, payload })
      expect(result.isError, payload).toBe(true)
      expect(result.content[0]!.text).toContain('payload is required')
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM boards').get()).toEqual({ c: 0 })
  })

  it('reports "with push" only when a doorbell was actually sent', async () => {
    const silent = tool({
      publish: () => ({ feedItemId: 'feed-1', deduped: false, notified: false }),
    })
    const pushed = tool({
      publish: () => ({ feedItemId: 'feed-2', deduped: false, notified: true }),
    })

    const withoutPush = await run(silent.instance, { ...valid, notify: true })
    expect(withoutPush.content[0]!.text).toContain('feed card feed-1')
    expect(withoutPush.content[0]!.text).not.toContain('with push')

    const withPush = await run(pushed.instance, { ...valid, key: 'portfolio-2', notify: true })
    expect(withPush.content[0]!.text).toContain('feed card feed-2 with push')
  })

  it('rejects a payload larger than 256 KB serialized', () => {
    const big = { schema_version: '1', blob: 'x'.repeat(300 * 1024) }
    const result = validateBoardParams({ key: 'big', kind: 'generic.v1', title: 'Big', payload: big })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('at most 262144 bytes')
  })

  it('names the depth problem instead of blaming cycles or functions', () => {
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let i = 0; i < 40_000; i++) {
      const next: Record<string, unknown> = {}
      deep.a = next
      deep = next
    }
    const result = validateBoardParams({ key: 'deep', kind: 'generic.v1', title: 'Deep', payload: root })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toBe('payload is nested too deeply to be serialized')
  })

  it('rejects a series point whose meta exceeds 4 KB serialized', () => {
    const result = validateBoardParams({
      key: 'portfolio', kind: 'generic.v1', title: 'Portfolio', payload: {},
      series: [{ series: 'total_eur', day: '2026-09-25', value: 1, meta: { note: 'x'.repeat(5000) } }],
    })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('series[0].meta must be at most 4096 bytes serialized')
  })

  it('rejects a series that is larger than 256 KB in total', () => {
    const series = Array.from({ length: 100 }, (_, i) => ({
      series: 'total_eur',
      day: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
      value: i,
      meta: { note: 'x'.repeat(4000) },
    }))
    const result = validateBoardParams({ key: 'portfolio', kind: 'generic.v1', title: 'P', payload: {}, series })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('series must be at most 262144 bytes serialized in total')
  })

  it('constrains series names to the URL-safe set the REST reader can split', () => {
    const check = (name: string) => validateBoardParams({
      key: 'portfolio', kind: 'generic.v1', title: 'P', payload: {},
      series: [{ series: name, day: '2026-09-25', value: 1 }],
    })
    // `pos:<ISIN>` is what the portfolio producer writes, and a canonical
    // ISIN is upper case — so upper case has to pass.
    for (const good of ['total_eur', 'pos:XX0000000001', 'cash.eur', 'day-delta', 'Total_EUR']) {
      expect(check(good), good).toMatchObject({ ok: true })
    }
    for (const bad of ['a,b', 'total eur', 'sum€', 'a\tb', 'a\nb', 'a/b']) {
      const result = check(bad)
      expect(result, bad).toMatchObject({ ok: false })
      expect((result as { error: string }).error).toContain('series[0].series must match')
    }
  })

  it('defaults as_of to now and keeps notify/dedupe optional', () => {
    const result = validateBoardParams(
      { key: 'portfolio', kind: 'generic.v1', title: ' Portfolio  Board ', payload: {} },
      () => new Date('2026-09-25T18:00:00.000Z'),
    )
    expect(result).toEqual({
      ok: true,
      value: {
        key: 'portfolio', kind: 'generic.v1', title: 'Portfolio Board', icon: null, summary: null,
        payload: {}, asOf: '2026-09-25T18:00:00.000Z', notify: false, dedupeKey: null, series: [],
      },
    })
  })
})

describe('portfolio_digest.v1 payload validation', () => {
  it('accepts the documented payload and ignores unknown fields', () => {
    expect(validatePortfolioDigestPayload({ ...digestPayload, invented_field: [1, 2, 3] })).toBeNull()
  })

  it('names the missing or malformed field', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...digestPayload, run_id: undefined }, 'payload.run_id is required'],
      [{ ...digestPayload, slot: '' }, 'payload.slot must be a non-empty string'],
      [{ ...digestPayload, digest: 42 }, 'payload.digest must be a non-empty string'],
      [{ ...digestPayload, overview: { ...digestPayload.overview, total_eur: 'lots' } }, 'payload.overview.total_eur'],
      [{ ...digestPayload, overview: { ...digestPayload.overview, day: { delta_eur: 1 } } }, 'payload.overview.day.delta_pct'],
      [{ ...digestPayload, overview: [] }, 'payload.overview must be an object'],
    ]
    for (const [payload, expected] of cases) {
      expect(validatePortfolioDigestPayload(payload)).toContain(expected)
    }
  })

  it('is only applied to that kind', () => {
    // The same incomplete payload passes under a different kind: the backend
    // stays generic, the check is a courtesy for one published contract.
    expect(validateBoardParams({ key: 'xy', kind: 'generic.v1', title: 'X', payload: { a: 1 } }).ok).toBe(true)
    expect(validateBoardParams({ key: 'xy', kind: 'portfolio_digest.v1', title: 'X', payload: { a: 1 } }).ok).toBe(false)
  })
})

describe('html_view.v1 through the tool', () => {
  const doc = '<!doctype html><html><body><svg width="10" height="10"></svg></body></html>'

  it('publishes a document as a board', async () => {
    const { instance, published } = tool()
    const result = await run(instance, {
      key: 'wheel-demo',
      kind: 'html_view.v1',
      title: 'Wheel',
      summary: 'A wheel.',
      payload: { html: doc, supports_theme: true, aspect_ratio: 1, min_height_px: 320 },
    })
    expect(result.isError).toBeFalsy()
    const stored = getBoard(db, '1', 'wheel-demo')
    expect(stored?.kind).toBe('html_view.v1')
    expect((stored?.payload as { html: string }).html).toBe(doc)
    expect(published).toHaveLength(1)
  })

  it('refuses a payload without a document instead of publishing an empty board', async () => {
    const { instance, published } = tool()
    const result = await run(instance, {
      key: 'wheel-demo', kind: 'html_view.v1', title: 'Wheel', payload: { htlm: doc },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('payload.html is required')
    expect(published).toHaveLength(0)
    expect(getBoard(db, '1', 'wheel-demo')).toBeNull()
  })

  it('gives this kind the bigger payload budget and still enforces it', async () => {
    const { instance } = tool()
    // 700 KB: past the 256 KB of every other kind, inside the 1 MB of this one.
    const ok = await run(instance, {
      key: 'big', kind: 'html_view.v1', title: 'Big', payload: { html: `<html>${'x'.repeat(700 * 1024)}</html>` },
    })
    expect(ok.isError).toBeFalsy()

    const tooBig = await run(instance, {
      key: 'huge', kind: 'html_view.v1', title: 'Huge', payload: { html: `<html>${'x'.repeat(1024 * 1024)}</html>` },
    })
    expect(tooBig.isError).toBe(true)
    expect(tooBig.content[0].text).toMatch(/at most (1024000 bytes|1048576 bytes serialized)/)

    // The bigger budget is strictly for html_view.v1.
    const otherKind = await run(instance, {
      key: 'other', kind: 'generic.v1', title: 'Other', payload: { blob: 'x'.repeat(300 * 1024) },
    })
    expect(otherKind.isError).toBe(true)
    expect(otherKind.content[0].text).toContain('at most 262144 bytes')
  })

  it('keeps the document of every revision', async () => {
    const { instance } = tool()
    await run(instance, { key: 'wheel-demo', kind: 'html_view.v1', title: 'Wheel', payload: { html: '<p>one</p>' } })
    await run(instance, { key: 'wheel-demo', kind: 'html_view.v1', title: 'Wheel', payload: { html: '<p>two</p>' } })
    const revisions = listBoardRevisions(db, '1', 'wheel-demo')
    expect(revisions.map(r => r.revision)).toEqual([2, 1])
    expect((getBoard(db, '1', 'wheel-demo')?.payload as { html: string }).html).toBe('<p>two</p>')
  })
})

describe('news_digest.v1 through the tool', () => {
  const newsPayload = {
    schema_version: 'news_digest.v1',
    date: '2026-09-28',
    headline: 'Two releases worth a look.',
    items: [{
      id: 'example-model-3', rank: 1, title: 'Example Lab releases model 3', category: 'frontier',
      verdict: 'hot', summary: 'A new model with a longer context window.',
      sources: [{ name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary' }],
    }],
    stats: { sources_checked: 31 },
  }

  it('publishes a digest as a board', async () => {
    const { instance, published } = tool()
    const result = await run(instance, {
      key: 'ai-news', kind: 'news_digest.v1', title: 'AI news', summary: 'Two releases.', payload: newsPayload,
    })
    expect(result.isError).toBeFalsy()
    const stored = getBoard(db, '1', 'ai-news')
    expect(stored?.kind).toBe('news_digest.v1')
    expect((stored?.payload as { items: unknown[] }).items).toHaveLength(1)
    expect(published).toHaveLength(1)
  })

  it('refuses a non-https source url instead of publishing a dead link', async () => {
    const { instance, published } = tool()
    const result = await run(instance, {
      key: 'ai-news', kind: 'news_digest.v1', title: 'AI news',
      payload: { ...newsPayload, items: [{ ...newsPayload.items[0], sources: [{ name: 'X', url: 'http://example.com/a' }] }] },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('must start with "https://"')
    expect(published).toHaveLength(0)
    expect(getBoard(db, '1', 'ai-news')).toBeNull()
  })

  it('is only applied to that kind', () => {
    const broken = { headline: '', items: [] }
    expect(validateBoardParams({ key: 'xy', kind: 'news_digest.v1', title: 'X', payload: broken }).ok).toBe(false)
    expect(validateBoardParams({ key: 'xy', kind: 'other_news.v1', title: 'X', payload: broken }).ok).toBe(true)
  })
})

describe('news_digest.v2 through the tool', () => {
  const newsPayload = {
    schema_version: 'news_digest.v2',
    date: '2026-09-28',
    headline: 'Two releases worth a look.',
    categories: { frontier: 'Frontier' },
    items: [{
      story_id: 'example-model-3', rank: 1, status: 'new', title: 'Example Lab releases model 3',
      take: 'Solid step, but the benchmark table only compares against its own predecessor.',
      category: 'frontier', verdict: 'hot', summary: 'A new model with a longer context window.',
      sources: [{ name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary', published_at: '2026-09-27' }],
    }],
    stats: { sources_checked: 31 },
  }

  it('publishes a v2 digest as a board', async () => {
    const { instance, published } = tool()
    const result = await run(instance, {
      key: 'ai-news', kind: 'news_digest.v2', title: 'AI news', summary: 'Two releases.', payload: newsPayload,
    })
    expect(result.isError).toBeFalsy()
    const stored = getBoard(db, '1', 'ai-news')
    expect(stored?.kind).toBe('news_digest.v2')
    expect((stored?.payload as { items: unknown[] }).items).toHaveLength(1)
    expect(published).toHaveLength(1)
  })

  it('refuses an item without take instead of publishing a list row without a verdict sentence', async () => {
    const { instance, published } = tool()
    const result = await run(instance, {
      key: 'ai-news', kind: 'news_digest.v2', title: 'AI news',
      payload: { ...newsPayload, items: [{ ...newsPayload.items[0], take: undefined }] },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('items[0].take is required')
    expect(published).toHaveLength(0)
    expect(getBoard(db, '1', 'ai-news')).toBeNull()
  })

  it('refuses a non-https source url instead of publishing a dead link', async () => {
    const { instance } = tool()
    const result = await run(instance, {
      key: 'ai-news', kind: 'news_digest.v2', title: 'AI news',
      payload: { ...newsPayload, items: [{ ...newsPayload.items[0], sources: [{ name: 'X', url: 'http://example.com/a' }] }] },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('must start with "https://"')
    expect(getBoard(db, '1', 'ai-news')).toBeNull()
  })

  it('keeps the v1 and the v2 gate apart', () => {
    // A v1 item shape must not sneak in under the v2 kind, and vice versa.
    const v1Item = { id: 'a', title: 'A', summary: 'B', verdict: 'hot', sources: [{ name: 'n', url: 'https://example.com/a' }] }
    expect(validateBoardParams({ key: 'xy', kind: 'news_digest.v2', title: 'X', payload: { headline: 'h', items: [v1Item] } }).ok).toBe(false)
    expect(validateBoardParams({ key: 'xy', kind: 'news_digest.v1', title: 'X', payload: { headline: 'h', items: [v1Item] } }).ok).toBe(true)
    expect(validateBoardParams({ key: 'xy', kind: 'news_digest.v2', title: 'X', payload: newsPayload }).ok).toBe(true)
  })
})
