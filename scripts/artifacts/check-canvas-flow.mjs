#!/usr/bin/env node
/**
 * Prove the canvas end to end against a real running backend (SPEC 7.4b, R2):
 * a real assistant turn writes a message with a ```html block, the artifact is
 * read back out of the chat history, its content is fetched through the
 * capability token and every security header is checked.
 *
 * Usage:
 *   node scripts/artifacts/check-canvas-flow.mjs [--db /path/to/copy.db]
 *
 * Without `--db` it boots on a throwaway database in a temp DATA_DIR. With
 * `--db` it uses the file you pass — that must be a COPY. This script writes.
 * NEVER point it at a live database.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const dbFlag = args.indexOf('--db')
const dbPath = dbFlag === -1 ? ':memory:' : args[dbFlag + 1]
if (dbFlag !== -1 && (!dbPath || !fs.existsSync(dbPath))) {
  console.error('--db needs the path to a COPY of a database.')
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-canvas-flow-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'canvas-flow-check-secret'
process.env.ADMIN_PASSWORD = 'canvas-flow-check'

const core = await import(path.join(root, 'packages/core/dist/index.js'))
const { createApp } = await import(path.join(root, 'packages/web-backend/dist/app.js'))
const { generateAccessToken } = await import(path.join(root, 'packages/web-backend/dist/auth.js'))

const failures = []
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const db = core.initDatabase(dbPath)
const user = db.prepare("SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
  ?? (() => {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('canvasflow', 'x', 'admin')
    return db.prepare('SELECT id, username, role FROM users ORDER BY id DESC LIMIT 1').get()
  })()

const strandId = `canvas-flow-${Date.now()}`
db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES (?, ?, 'web', 'interactive')")
  .run(strandId, user.id)

const app = createApp({ db })
const server = http.createServer(app)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const token = generateAccessToken({ userId: user.id, username: user.username, role: user.role ?? 'admin' })

console.log(`\n=== 1. a real turn writes an assistant message with a \`\`\`html block ===`)
const fence = '```'
const answer = [
  'Kurz: Variante B ist ueber zehn Jahre billiger. Details im Canvas.',
  '',
  `${fence}html Dachvergleich`,
  '<!doctype html><html><head><title>Dach</title></head><body><h1>Dachvergleich</h1></body></html>',
  fence,
].join('\n')

const runner = new core.TurnRunner({
  db,
  getAgent: () => ({
    sendMessage: async function* () {
      yield { type: 'text', text: answer }
      yield { type: 'done' }
    },
    abort: () => {},
  }),
})
const events = []
runner.subscribe(user.id, e => events.push(e))
runner.startTurn({ userId: user.id, sessionId: strandId, text: 'Vergleich die beiden Dachangebote' })
const deadline = Date.now() + 5000
while (!events.some(e => e.type === 'turn_end')) {
  if (Date.now() > deadline) throw new Error('turn did not end')
  await new Promise(r => setTimeout(r, 10))
}
const row = db.prepare(
  "SELECT id, content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
).get(strandId)
check('assistant row persisted', Boolean(row), `id=${row?.id}`)
check('fence still in the message text (Telegram/web fallback)', row.content.includes('```html Dachvergleich'))
check('message text unchanged', row.content === answer)

console.log(`\n=== 2. the artifact id comes out of the chat history ===`)
const history = await (await fetch(`${base}/api/chat/history?session_id=${strandId}&limit=50`, {
  headers: { Authorization: `Bearer ${token}` },
})).json()
const message = history.messages.find(m => m.id === row.id)
check('history carries artifact references', Array.isArray(message?.artifacts) && message.artifacts.length === 1,
  JSON.stringify(message?.artifacts ?? []))
const ref = message.artifacts[0]
check('artifact is typed and titled', ref.kind === 'html' && ref.title === 'Dachvergleich' && ref.source === 'inline_fence')
check('artifact belongs to the strand and the message', ref.strandId === strandId && ref.messageId === row.id)
check('owner is not echoed back', !('userId' in ref))

const list = await (await fetch(`${base}/api/artifacts?strandId=${strandId}`, {
  headers: { Authorization: `Bearer ${token}` },
})).json()
check('GET /api/artifacts lists it', list.artifacts.some(a => a.id === ref.id))

console.log(`\n=== 3. metadata + a short lived content url ===`)
const detail = await (await fetch(`${base}/api/artifacts/${ref.id}`, {
  headers: { Authorization: `Bearer ${token}` },
})).json()
check('contentUrl minted', typeof detail.contentUrl === 'string' && detail.contentUrl.includes('/content?t='))
check('access token NOT in the content url', !detail.contentUrl.includes(token))
check('embed contract says allow-scripts without allow-same-origin',
  detail.embed.iframeSandbox === 'allow-scripts' && !detail.embed.iframeSandbox.includes('allow-same-origin'))
check('content url expires', Date.parse(detail.contentExpiresAt) > Date.now())

console.log(`\n=== 4. the bytes, and the headers that keep them harmless ===`)
const contentRes = await fetch(`${base}${detail.contentUrl}`)
const body = await contentRes.text()
check('200 with the exact block body', contentRes.status === 200 && body.includes('<h1>Dachvergleich</h1>'))
const headers = Object.fromEntries(contentRes.headers.entries())
for (const [name, value] of Object.entries(headers)) {
  if (['content-security-policy', 'x-content-type-options', 'referrer-policy', 'permissions-policy',
    'cache-control', 'content-type', 'content-disposition', 'x-frame-options',
    'cross-origin-resource-policy'].includes(name)) {
    console.log(`      ${name}: ${value}`)
  }
}
const csp = headers['content-security-policy'] ?? ''
check("CSP default-src 'none'", csp.includes("default-src 'none'"))
check("CSP connect-src 'none' (no way back into /api/*)", csp.includes("connect-src 'none'"))
check("CSP form-action 'none'", csp.includes("form-action 'none'"))
check('CSP sandbox allow-scripts (opaque origin, enforced by the server)', csp.includes('sandbox allow-scripts'))
check('CSP never allows allow-same-origin', !csp.includes('allow-same-origin'))
check('CSP sets frame-ancestors', csp.includes('frame-ancestors'))
check('nosniff', headers['x-content-type-options'] === 'nosniff')
check('no-referrer', headers['referrer-policy'] === 'no-referrer')
check('no-store', (headers['cache-control'] ?? '').includes('no-store'))
check('inline disposition for an allowed kind', (headers['content-disposition'] ?? '').startsWith('inline;'))

console.log(`\n=== 5. what must NOT work ===`)
const noCred = await fetch(`${base}/api/artifacts/${ref.id}/content`)
check('content without a credential -> 401', noCred.status === 401, `got ${noCred.status}`)
const jwtInQuery = await fetch(`${base}/api/artifacts/${ref.id}/content?token=${encodeURIComponent(token)}`)
check('access token in the query string -> 401', jwtInQuery.status === 401, `got ${jwtInQuery.status}`)

db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
  .run(`stranger-${Date.now()}`, 'x', 'user')
const stranger = db.prepare('SELECT id, username FROM users ORDER BY id DESC LIMIT 1').get()
const strangerToken = generateAccessToken({ userId: stranger.id, username: stranger.username, role: 'user' })
const foreignDetail = await fetch(`${base}/api/artifacts/${ref.id}`, {
  headers: { Authorization: `Bearer ${strangerToken}` },
})
check('foreign metadata read -> 404', foreignDetail.status === 404, `got ${foreignDetail.status}`)
const foreignContent = await fetch(`${base}/api/artifacts/${ref.id}/content`, {
  headers: { Authorization: `Bearer ${strangerToken}` },
})
check('foreign content read -> 404', foreignContent.status === 404, `got ${foreignContent.status}`)
const foreignList = await (await fetch(`${base}/api/artifacts?strandId=${strandId}`, {
  headers: { Authorization: `Bearer ${strangerToken}` },
})).json()
check('foreign list is empty', foreignList.artifacts.length === 0)

console.log(`\n=== 6. reload: the canvas reopens from the strand ===`)
const reopened = await (await fetch(`${base}/api/artifacts/${ref.id}`, {
  headers: { Authorization: `Bearer ${token}` },
})).json()
const reopenedContent = await fetch(`${base}${reopened.contentUrl}`)
check('artifact still readable with a freshly minted token', reopenedContent.status === 200)

console.log(`\n=== 7. a message without an html block creates nothing ===`)
const before = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n
const plainRunner = new core.TurnRunner({
  db,
  getAgent: () => ({
    sendMessage: async function* () {
      yield { type: 'text', text: `Nein, das reicht als Text.\n\n${fence}bash\nls -la\n${fence}` }
      yield { type: 'done' }
    },
    abort: () => {},
  }),
})
const plainEvents = []
plainRunner.subscribe(user.id, e => plainEvents.push(e))
plainRunner.startTurn({ userId: user.id, sessionId: strandId, text: 'reicht das?' })
const plainDeadline = Date.now() + 5000
while (!plainEvents.some(e => e.type === 'turn_end')) {
  if (Date.now() > plainDeadline) throw new Error('turn did not end')
  await new Promise(r => setTimeout(r, 10))
}
check('no artifact created', db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n === before)

await new Promise(resolve => server.close(resolve))
db.close()
fs.rmSync(dataDir, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
