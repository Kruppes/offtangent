/**
 * /api/boards against a real database. Boards are per user, so every read
 * path is also checked against a second user's token: a foreign board must
 * look exactly like a board that does not exist (404, never 403).
 *
 * Fixtures are synthetic: "Alpha Corp", "Beta Industries", ISIN-shaped
 * strings like XX0000000001 that belong to no real instrument.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { BOARD_LINK_BRIDGE_MARKER, initDatabase, upsertBoard, upsertBoardSeries } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createBoardsRouter } from './route.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let memberToken: string

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(3, 'member', 'x', 'user')

  const app = express()
  app.use(express.json())
  app.use('/api/boards', createBoardsRouter({ db }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
  memberToken = generateAccessToken({ userId: 3, username: 'member', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
})

beforeEach(() => {
  db.exec('DELETE FROM boards; DELETE FROM board_revisions; DELETE FROM board_series')
})

async function api(method: string, path: string, body?: unknown, auth: string | null = token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const payload = {
  schema_version: 'portfolio_digest.v1',
  run_id: 'run-1',
  slot: 'evening',
  as_of: '2026-09-25T20:00:00Z',
  overview: { securities_eur: 1000, cash_eur: 250, total_eur: 1250, day: { delta_eur: 12.5, delta_pct: 1.01 } },
  digest: 'Alpha Corp up, Beta Industries flat.',
  movers: { gainers: [{ name: 'Alpha Corp', isin: 'XX0000000001' }], losers: [] },
}

function seed(userId: string, key = 'portfolio', overrides: Record<string, unknown> = {}) {
  return upsertBoard(db, {
    userId,
    key,
    kind: 'portfolio_digest.v1',
    title: 'Portfolio',
    icon: '📈',
    agentId: 'main',
    summary: 'Up 1.0% today.',
    payload,
    asOf: '2026-09-25T20:00:00Z',
    ...overrides,
  })
}

describe('GET /api/boards', () => {
  it('lists only the caller boards, without the payload', async () => {
    seed('1', 'portfolio')
    seed('1', 'site-health', { kind: 'generic.v1', title: 'Site health' })
    seed('2', 'secret', { title: 'Not yours' })

    const res = await api('GET', '/api/boards')
    expect(res.status).toBe(200)
    expect(res.body.boards.map((b: { key: string }) => b.key).sort()).toEqual(['portfolio', 'site-health'])
    expect(Object.keys(res.body.boards[0]).sort()).toEqual(
      ['agentId', 'asOf', 'icon', 'key', 'kind', 'revision', 'summary', 'title', 'updatedAt'],
    )
    expect((await api('GET', '/api/boards', undefined, memberToken)).body.boards).toEqual([])
  })

  it('needs a token', async () => {
    expect((await api('GET', '/api/boards', undefined, null)).status).toBe(401)
  })
})

describe('GET /api/boards/:key', () => {
  it('returns the board with the payload as an object', async () => {
    seed('1')
    const res = await api('GET', '/api/boards/portfolio')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      key: 'portfolio', kind: 'portfolio_digest.v1', title: 'Portfolio', icon: '📈',
      agentId: 'main', revision: 1, summary: 'Up 1.0% today.', asOf: '2026-09-25T20:00:00Z',
    })
    expect(res.body.payload).toEqual(payload)
    expect(typeof res.body.payload).toBe('object')
  })

  it('answers 404 for a foreign board, an unknown key and a malformed key', async () => {
    seed('1')
    expect((await api('GET', '/api/boards/portfolio', undefined, otherToken)).status).toBe(404)
    expect((await api('GET', '/api/boards/unknown-board')).status).toBe(404)
    const malformed = await api('GET', '/api/boards/Portfolio')
    expect(malformed.status).toBe(404)
    expect(malformed.body.code).toBe('board_not_found')
  })
})

describe('GET /api/boards/:key/revisions', () => {
  it('lists the revisions newest first and serves one of them', async () => {
    seed('1', 'portfolio', { summary: 'first' })
    seed('1', 'portfolio', { summary: 'second', payload: { ...payload, digest: 'Second run.' } })

    const list = await api('GET', '/api/boards/portfolio/revisions')
    expect(list.status).toBe(200)
    expect(list.body.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1])
    expect(Object.keys(list.body.revisions[0]).sort()).toEqual(['asOf', 'createdAt', 'revision', 'summary'])

    const first = await api('GET', '/api/boards/portfolio/revisions/1')
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      key: 'portfolio', revision: 1, summary: 'first',
      kind: 'portfolio_digest.v1', title: 'Portfolio', icon: '📈', agentId: 'main',
    })
    // The client picks its renderer from `kind`, so a revision carries the
    // identity of its board on top of the revision's own state.
    expect(Object.keys(first.body).sort()).toEqual(
      ['agentId', 'asOf', 'createdAt', 'icon', 'key', 'kind', 'payload', 'revision', 'summary', 'title', 'updatedAt'],
    )
    expect(first.body.payload).toEqual(payload)

    expect((await api('GET', '/api/boards/portfolio/revisions/99')).status).toBe(404)
    expect((await api('GET', '/api/boards/portfolio/revisions/abc')).status).toBe(404)
  })

  it('hides the revisions of a foreign board', async () => {
    seed('1')
    expect((await api('GET', '/api/boards/portfolio/revisions', undefined, otherToken)).status).toBe(404)
    expect((await api('GET', '/api/boards/portfolio/revisions/1', undefined, otherToken)).status).toBe(404)
  })
})

describe('GET /api/boards/:key/series', () => {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  beforeEach(() => {
    seed('1')
    upsertBoardSeries(db, '1', 'portfolio', [
      { series: 'total_eur', day: yesterday, value: 1237.5 },
      { series: 'total_eur', day: today, value: 1250 },
      { series: 'cash_eur', day: today, value: 250 },
    ])
  })

  it('returns the requested series oldest first', async () => {
    const res = await api('GET', '/api/boards/portfolio/series?series=total_eur,cash_eur&days=90')
    expect(res.status).toBe(200)
    expect(res.body.series.total_eur).toEqual([
      { day: yesterday, value: 1237.5 },
      { day: today, value: 1250 },
    ])
    expect(res.body.series.cash_eur).toEqual([{ day: today, value: 250 }])
  })

  it('clamps days to 400 and rejects a broken query', async () => {
    expect((await api('GET', '/api/boards/portfolio/series?series=total_eur&days=100000')).status).toBe(200)
    expect((await api('GET', '/api/boards/portfolio/series?series=total_eur&days=0')).body.code).toBe('invalid_days')
    expect((await api('GET', '/api/boards/portfolio/series')).body.code).toBe('invalid_series')
  })

  it('hides the series of a foreign board', async () => {
    const res = await api('GET', '/api/boards/portfolio/series?series=total_eur', undefined, otherToken)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/boards/:key', () => {
  it('is admin only and removes board, revisions and series', async () => {
    seed('1')
    upsertBoardSeries(db, '1', 'portfolio', [{ series: 'total_eur', day: '2026-09-25', value: 1250 }])

    expect((await api('DELETE', '/api/boards/portfolio', undefined, memberToken)).status).toBe(403)
    expect((await api('GET', '/api/boards/portfolio')).status).toBe(200)

    expect((await api('DELETE', '/api/boards/portfolio')).status).toBe(204)
    expect((await api('GET', '/api/boards/portfolio')).status).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS c FROM board_revisions').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM board_series').get()).toEqual({ c: 0 })

    expect((await api('DELETE', '/api/boards/portfolio')).status).toBe(404)
  })

  it('does not let an admin delete across users by accident', async () => {
    // The admin token is user 1; user 2's board is invisible to it, so the
    // delete is a 404 and the row survives.
    seed('2')
    expect((await api('DELETE', '/api/boards/portfolio')).status).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS c FROM boards WHERE user_id = ?').get('2')).toEqual({ c: 1 })
  })
})

/** The document as the producer wrote it: the injected link bridge removed. */
function withoutBridge(html: string): string {
  return html.replace(/<script data-offtangent-link-bridge>[\s\S]*?<\/script>/, '')
}

/**
 * `html_view.v1`: the document never travels inside the JSON a renderer could
 * inject — it is fetched from a sandboxed content route with a capability
 * token, exactly like a canvas artifact.
 */
describe('html_view.v1 content route', () => {
  const doc = '<!doctype html><html><body><p id="rev">current</p></body></html>'

  function seedHtml(userId: string, key = 'wheel-demo', html = doc, revisionLabel = 'current') {
    return upsertBoard(db, {
      userId,
      key,
      kind: 'html_view.v1',
      title: 'Wheel check',
      icon: '🛞',
      agentId: 'analyst',
      summary: `Truing state (${revisionLabel}).`,
      payload: { html, supports_theme: true, aspect_ratio: 1, min_height_px: 320 },
      asOf: '2026-09-26T10:00:00Z',
    })
  }

  async function raw(target: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${target}`, { headers })
    return { status: res.status, text: await res.text(), headers: res.headers }
  }

  it('hands out a content URL with a capability token, not the raw document to inject', async () => {
    seedHtml('1')
    const res = await api('GET', '/api/boards/wheel-demo')
    expect(res.status).toBe(200)
    expect(res.body.content.url).toMatch(/^\/api\/boards\/wheel-demo\/content\?t=/)
    expect(res.body.content.url).not.toContain('token=')
    expect(res.body.content).toMatchObject({
      supportsTheme: true,
      aspectRatio: 1,
      minHeightPx: 320,
      embed: {
        iframeSandbox: 'allow-scripts',
        iframeReferrerPolicy: 'no-referrer',
        separateOrigin: false,
        denies: ['same-origin', 'cookies', 'localStorage', 'network', 'top-navigation'],
      },
    })
    // Never `allow-same-origin`: that plus allow-scripts would undo the sandbox.
    expect(res.body.content.embed.iframeSandbox).not.toContain('same-origin')
    expect(Date.parse(res.body.content.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('serves the document with the artifact security headers', async () => {
    seedHtml('1')
    const url = (await api('GET', '/api/boards/wheel-demo')).body.content.url
    const res = await raw(url)
    expect(res.status).toBe(200)
    // The only thing the server adds is the link bridge (see board-link-bridge.ts).
    expect(res.text).toContain(BOARD_LINK_BRIDGE_MARKER)
    expect(withoutBridge(res.text)).toBe(doc)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('content-disposition')).toBe('inline; filename="Wheel_check.html"')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('refuses the document without a token, with a foreign token and with an access token in the query', async () => {
    seedHtml('1')
    const url = (await api('GET', '/api/boards/wheel-demo')).body.content.url
    const tokenValue = new URL(`http://x${url}`).searchParams.get('t')!

    expect((await raw('/api/boards/wheel-demo/content')).status).toBe(401)
    expect((await raw(`/api/boards/wheel-demo/content?t=${encodeURIComponent(tokenValue)}x`)).status).toBe(401)
    // The access token is not a content credential: model written HTML can read its own URL.
    expect((await raw(`/api/boards/wheel-demo/content?token=${token}`)).status).toBe(401)
    // A Bearer header still works for programmatic clients.
    expect((await raw('/api/boards/wheel-demo/content', { Authorization: `Bearer ${token}` })).status).toBe(200)
    // …but only for the owner.
    expect((await raw('/api/boards/wheel-demo/content', { Authorization: `Bearer ${otherToken}` })).status).toBe(404)
  })

  it('does not let one board token open another board', async () => {
    seedHtml('1', 'wheel-demo')
    seedHtml('1', 'wheel-other')
    const url = (await api('GET', '/api/boards/wheel-demo')).body.content.url
    const tokenValue = new URL(`http://x${url}`).searchParams.get('t')!
    expect((await raw(`/api/boards/wheel-other/content?t=${encodeURIComponent(tokenValue)}`)).status).toBe(401)
  })

  it('serves an older revision as it was published', async () => {
    seedHtml('1', 'wheel-demo', '<p id="rev">one</p>', 'one')
    seedHtml('1', 'wheel-demo', '<p id="rev">two</p>', 'two')

    const current = await api('GET', '/api/boards/wheel-demo')
    expect(current.body.revision).toBe(2)
    expect(withoutBridge((await raw(current.body.content.url)).text)).toBe('<p id="rev">two</p>')

    const historic = await api('GET', '/api/boards/wheel-demo/revisions/1')
    expect(historic.status).toBe(200)
    expect(historic.body.content.url).toMatch(/^\/api\/boards\/wheel-demo\/revisions\/1\/content\?t=/)
    const served = await raw(historic.body.content.url)
    expect(served.status).toBe(200)
    expect(withoutBridge(served.text)).toBe('<p id="rev">one</p>')
    expect(served.headers.get('content-security-policy')).toContain('sandbox allow-scripts')

    // A token minted for the archive does not open the live board and vice versa.
    const historicToken = new URL(`http://x${historic.body.content.url}`).searchParams.get('t')!
    expect((await raw(`/api/boards/wheel-demo/content?t=${encodeURIComponent(historicToken)}`)).status).toBe(401)
    const currentToken = new URL(`http://x${current.body.content.url}`).searchParams.get('t')!
    expect((await raw(`/api/boards/wheel-demo/revisions/1/content?t=${encodeURIComponent(currentToken)}`)).status).toBe(401)
  })

  it('stays silent about other kinds and about boards of other users', async () => {
    seed('1', 'portfolio')
    seedHtml('2', 'secret-board')

    // A portfolio board has no content block and no document route.
    expect((await api('GET', '/api/boards/portfolio')).body.content).toBeUndefined()
    expect((await raw('/api/boards/portfolio/content', { Authorization: `Bearer ${token}` })).status).toBe(404)
    // A foreign html board is a 404 for the caller, never a 403.
    expect((await api('GET', '/api/boards/secret-board')).status).toBe(404)
    expect((await raw('/api/boards/secret-board/content', { Authorization: `Bearer ${token}` })).status).toBe(404)
  })

  it('does not serve a document for a payload it cannot read', async () => {
    upsertBoard(db, {
      userId: '1',
      key: 'broken-html',
      kind: 'html_view.v1',
      title: 'Broken',
      payload: { html: '' },
      asOf: '2026-09-26T10:00:00Z',
    })
    expect((await api('GET', '/api/boards/broken-html')).body.content).toBeUndefined()
    expect((await raw('/api/boards/broken-html/content', { Authorization: `Bearer ${token}` })).status).toBe(410)
  })

  it('serves the document verbatim — a hostile page is contained, not filtered', async () => {
    const hostile = '<script>fetch("/api/boards").then(r=>r.text()).then(t=>top.location="/?"+t)</script>'
    seedHtml('1', 'wheel-demo', hostile)
    const url = (await api('GET', '/api/boards/wheel-demo')).body.content.url
    const res = await raw(url)
    // Byte identical apart from the appended link bridge: the CSP (opaque
    // origin, no connect-src, no form-action, no top navigation) is what makes
    // this script harmless.
    expect(withoutBridge(res.text)).toBe(hostile)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).toContain("connect-src 'none'")
  })
})


/**
 * A board kind that is NOT built into any client: the renderer is a file the
 * operator drops under `<DATA_DIR>/board-renderers/`, the server injects the
 * board state into it and serves it through the very same sandbox.
 *
 * The fixture renderer lives in `__fixtures__`, never under a real DATA_DIR.
 */
describe('server side renderer registry', () => {
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '__fixtures__',
    'demo_list.v1.html',
  )
  let renderersDir: string

  function installRenderer(kind = 'demo_list.v1', source = fixture) {
    fs.mkdirSync(renderersDir, { recursive: true })
    fs.copyFileSync(source, path.join(renderersDir, `${kind}.html`))
  }

  function seedList(userId: string, key = 'demo', payload: unknown = { items: [{ title: 'Alice', url: 'https://example.com/alice' }] }) {
    return upsertBoard(db, {
      userId,
      key,
      kind: 'demo_list.v1',
      title: 'Demo list',
      icon: '🧪',
      agentId: 'main',
      summary: 'One entry.',
      payload,
      asOf: '2026-09-28T06:00:00Z',
    })
  }

  async function raw(target: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${target}`, { headers })
    return { status: res.status, text: await res.text(), headers: res.headers }
  }

  beforeEach(() => {
    renderersDir = path.join(process.env.DATA_DIR!, 'board-renderers')
    fs.rmSync(renderersDir, { recursive: true, force: true })
  })

  it('keeps the old behaviour when the kind has no renderer', async () => {
    seedList('1')
    const board = await api('GET', '/api/boards/demo')
    expect(board.status).toBe(200)
    expect(board.body.content).toBeUndefined()
    expect((await raw('/api/boards/demo/content', { Authorization: `Bearer ${token}` })).status).toBe(404)
  })

  it('hands out the same content block html_view gets once a renderer exists', async () => {
    seedList('1')
    installRenderer()
    const board = await api('GET', '/api/boards/demo')
    expect(board.body.content.url).toMatch(/^\/api\/boards\/demo\/content\?t=/)
    expect(board.body.content).toMatchObject({
      supportsTheme: true,
      aspectRatio: null,
      minHeightPx: null,
      embed: { iframeSandbox: 'allow-scripts', iframeReferrerPolicy: 'no-referrer' },
    })
    expect(board.body.content.embed.iframeSandbox).not.toContain('same-origin')
    // The payload stays in the JSON response too: the data is still machine readable.
    expect(board.body.payload).toEqual({ items: [{ title: 'Alice', url: 'https://example.com/alice' }] })
  })

  it('serves the renderer with the board state injected and the same security headers', async () => {
    seedList('1')
    installRenderer()
    const url = (await api('GET', '/api/boards/demo')).body.content.url
    const res = await raw(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('content-disposition')).toBe('inline; filename="Demo_list.html"')

    const island = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(res.text)
    expect(island).not.toBeNull()
    expect(JSON.parse(island![1])).toEqual({
      key: 'demo',
      kind: 'demo_list.v1',
      title: 'Demo list',
      revision: 1,
      as_of: '2026-09-28T06:00:00Z',
      summary: 'One entry.',
      payload: { items: [{ title: 'Alice', url: 'https://example.com/alice' }] },
    })
    // Injected before </head>, and the link bridge is there too.
    expect(res.text.indexOf('id="board-data"')).toBeLessThan(res.text.indexOf('</head>'))
    expect(res.text).toContain(BOARD_LINK_BRIDGE_MARKER)
  })

  it('cannot be escaped by a payload that closes the script element', async () => {
    seedList('1', 'demo', { items: [{ title: '</script><script>alert(1)</script>', url: 'https://example.com/x' }], sep: 'a\u2028b' })
    installRenderer()
    const url = (await api('GET', '/api/boards/demo')).body.content.url
    const res = await raw(url)
    const island = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(res.text)!
    expect(island[1]).not.toContain('<')
    expect(island[1]).not.toContain('\u2028')
    expect(JSON.parse(island[1]).payload.items[0].title).toBe('</script><script>alert(1)</script>')
    // Only two script elements: the data island and the link bridge, plus the
    // renderer's own one. Nothing the payload smuggled in.
    expect(res.text).not.toContain('<script>alert(1)</script>')
  })

  it('renders an older revision with the state of that revision', async () => {
    seedList('1', 'demo', { items: [{ title: 'first' }] })
    seedList('1', 'demo', { items: [{ title: 'second' }] })
    installRenderer()

    const current = await api('GET', '/api/boards/demo')
    expect(current.body.revision).toBe(2)
    const historic = await api('GET', '/api/boards/demo/revisions/1')
    expect(historic.body.content.url).toMatch(/^\/api\/boards\/demo\/revisions\/1\/content\?t=/)

    const served = await raw(historic.body.content.url)
    expect(served.status).toBe(200)
    const island = /id="board-data">([\s\S]*?)<\/script>/.exec(served.text)!
    expect(JSON.parse(island[1]).payload).toEqual({ items: [{ title: 'first' }] })
    expect(JSON.parse(island[1]).revision).toBe(1)
    expect(served.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
  })

  it('picks up a renderer added after the board was read, without a restart', async () => {
    seedList('1')
    expect((await api('GET', '/api/boards/demo')).body.content).toBeUndefined()
    installRenderer()
    expect((await api('GET', '/api/boards/demo')).body.content.url).toContain('/content?t=')
  })

  it('never reads a renderer through a symlink or from outside the directory', async () => {
    seedList('1')
    fs.mkdirSync(renderersDir, { recursive: true })
    const secret = path.join(process.env.DATA_DIR!, 'secret.html')
    fs.writeFileSync(secret, '<p>TOP SECRET</p>')
    fs.symlinkSync(secret, path.join(renderersDir, 'demo_list.v1.html'))
    expect((await api('GET', '/api/boards/demo')).body.content).toBeUndefined()
    const res = await raw('/api/boards/demo/content', { Authorization: `Bearer ${token}` })
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('TOP SECRET')
  })

  it('still refuses a foreign board and a missing token', async () => {
    seedList('2', 'demo')
    installRenderer()
    expect((await api('GET', '/api/boards/demo')).status).toBe(404)
    expect((await raw('/api/boards/demo/content')).status).toBe(401)
    expect((await raw('/api/boards/demo/content', { Authorization: `Bearer ${token}` })).status).toBe(404)
  })

  it('leaves a built-in kind alone when no renderer file exists for it', async () => {
    seed('1', 'portfolio')
    installRenderer('demo_list.v1')
    expect((await api('GET', '/api/boards/portfolio')).body.content).toBeUndefined()
  })
})
