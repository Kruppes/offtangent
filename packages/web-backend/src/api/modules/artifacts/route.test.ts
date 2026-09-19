/**
 * /api/artifacts (SPEC 7.4b, canvas R2) against a real database.
 *
 * The interesting assertions here are the security ones: an artifact is LLM
 * written code, so the content route must never run it with access to the app
 * origin, the JWT, cookies or `/api/*`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, recordMessageArtifacts } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createArtifactsRouter } from './route.js'
import { createChatRouter } from '../../../routes/chat.js'
import { generateAccessToken } from '../../../auth.js'
import { mintArtifactToken } from '../../../artifact-token.js'

const fence = '```'
const STRAND = 'strand-canvas-routes'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let tempDataDir: string
let previousDataDir: string | undefined

interface ArtifactRefBody {
  id: string
  strandId: string
  messageId: number
  kind: string
  title: string
  source: string
  size: number
  createdAt: string
}

function seedMessage(content: string, sessionId = STRAND, userId = 1): number {
  return Number(db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, 'assistant', ?, 'main')",
  ).run(sessionId, userId, content).lastInsertRowid)
}

function seedArtifact(content: string, sessionId = STRAND, userId = 1) {
  const messageId = seedMessage(content, sessionId, userId)
  const result = recordMessageArtifacts(db, { messageId, strandId: sessionId, userId, content, agentId: 'main' })
  return { messageId, artifact: result.artifacts[0]! }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-artifact-routes-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  const app = express()
  app.use(express.json())
  app.use('/api/artifacts', createArtifactsRouter({ db }))
  app.use('/api/chat', createChatRouter({ db }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

beforeEach(() => {
  db.exec('DELETE FROM artifacts')
  db.exec('DELETE FROM chat_messages')
})

describe('GET /api/artifacts', () => {
  it('lists the artifacts of a strand', async () => {
    seedArtifact(`Zusammenfassung.\n${fence}html Eins\n<p>1</p>\n${fence}`)
    seedArtifact(`Noch eins.\n${fence}html Zwei\n<p>2</p>\n${fence}`)
    seedArtifact(`Anderer Strand.\n${fence}html Drei\n<p>3</p>\n${fence}`, 'strand-other')

    const res = await fetch(`${baseUrl}/api/artifacts?strandId=${STRAND}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { artifacts: ArtifactRefBody[] }
    expect(body.artifacts.map(a => a.title)).toEqual(['Eins', 'Zwei'])
    expect(body.artifacts[0]).toMatchObject({ kind: 'html', source: 'inline_fence', strandId: STRAND })
    expect(body.artifacts[0]).not.toHaveProperty('userId')
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/artifacts?strandId=${STRAND}`)
    expect(res.status).toBe(401)
  })

  it('never shows another user their artifacts', async () => {
    seedArtifact(`${fence}html Privat\n<p>x</p>\n${fence}`)
    const res = await fetch(`${baseUrl}/api/artifacts?strandId=${STRAND}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { artifacts: unknown[] }).artifacts).toEqual([])
  })

  it('rejects a broken limit', async () => {
    const res = await fetch(`${baseUrl}/api/artifacts?limit=-4`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(400)
    expect((await res.json() as { code: string }).code).toBe('invalid_limit')
  })
})

describe('GET /api/artifacts/:id', () => {
  it('returns metadata plus a short lived content url and the embed contract', async () => {
    const { artifact } = seedArtifact(`${fence}html Detail\n<h1>d</h1>\n${fence}`)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      artifact: ArtifactRefBody
      contentUrl: string
      contentExpiresAt: string
      embed: { iframeSandbox: string; iframeReferrerPolicy: string; separateOrigin: boolean; denies: string[] }
    }
    expect(body.artifact.title).toBe('Detail')
    expect(body.contentUrl).toContain(`/api/artifacts/${artifact.id}/content?t=`)
    // The access token must never be part of an URL the artifact can read.
    expect(body.contentUrl).not.toContain(token)
    expect(Date.parse(body.contentExpiresAt)).toBeGreaterThan(Date.now())
    expect(body.embed.iframeSandbox).toBe('allow-scripts')
    expect(body.embed.iframeSandbox).not.toContain('allow-same-origin')
    expect(body.embed.iframeReferrerPolicy).toBe('no-referrer')
  })

  it('answers 404 for a foreign artifact instead of 403 leaking its existence', async () => {
    const { artifact } = seedArtifact(`${fence}html Fremd\n<p>x</p>\n${fence}`)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { code: string }).code).toBe('artifact_not_found')
  })

  it('answers 404 for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/artifacts/11111111-2222-3333-4444-555555555555`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/artifacts/:id/content', () => {
  async function contentResponse(): Promise<{ res: Response; body: string; artifactId: string }> {
    const { artifact } = seedArtifact(`${fence}html Canvas\n<h1>hallo</h1>\n${fence}`)
    const detail = await (await fetch(`${baseUrl}/api/artifacts/${artifact.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json() as { contentUrl: string }
    const res = await fetch(`${baseUrl}${detail.contentUrl}`)
    return { res, body: await res.text(), artifactId: artifact.id }
  }

  it('serves the raw bytes for a valid capability token', async () => {
    const { res, body } = await contentResponse()
    expect(res.status).toBe(200)
    expect(body).toBe('<h1>hallo</h1>')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('sets a CSP that cuts the artifact off from the app and from /api/*', async () => {
    const { res } = await contentResponse()
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("script-src 'unsafe-inline'")
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).toContain('frame-ancestors')
    // The load bearing line: an opaque origin even when the embedder forgets
    // the sandbox attribute. `allow-same-origin` must never appear.
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
  })

  it('sets the remaining hardening headers', async () => {
    const { res } = await contentResponse()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('permissions-policy')).toContain('camera=()')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="Canvas\.html"$/)
  })

  it('gives an svg artifact no script budget at all', async () => {
    const { artifact } = seedArtifact(`${fence}svg Plot\n<svg xmlns="http://www.w3.org/2000/svg"/>\n${fence}`)
    const minted = mintArtifactToken(artifact.id, 1)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content?t=${encodeURIComponent(minted.token)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'none'")
    expect(csp).toMatch(/sandbox$/)
  })

  it('drops X-Frame-Options once frame-ancestors carries an allow list', async () => {
    const previous = process.env.ARTIFACT_FRAME_ANCESTORS
    process.env.ARTIFACT_FRAME_ANCESTORS = "'self' https://app.example"
    try {
      const { res } = await contentResponse()
      expect(res.headers.get('content-security-policy')).toContain('frame-ancestors \'self\' https://app.example')
      // X-Frame-Options cannot express an allow list; keeping it would block
      // a legitimate cross-origin embed on engines that still honour it.
      expect(res.headers.get('x-frame-options')).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.ARTIFACT_FRAME_ANCESTORS
      else process.env.ARTIFACT_FRAME_ANCESTORS = previous
    }
  })

  it('refuses a request without any credential', async () => {
    const { artifact } = seedArtifact(`${fence}html\n<p>x</p>\n${fence}`)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`)
    expect(res.status).toBe(401)
  })

  it('refuses an access token in the query string', async () => {
    const { artifact } = seedArtifact(`${fence}html\n<p>x</p>\n${fence}`)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(401)
  })

  it('refuses a token minted for another artifact', async () => {
    const { artifact } = seedArtifact(`${fence}html Eins\n<p>1</p>\n${fence}`)
    const { artifact: second } = seedArtifact(`${fence}html Zwei\n<p>2</p>\n${fence}`)
    const minted = mintArtifactToken(second.id, 1)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content?t=${encodeURIComponent(minted.token)}`)
    expect(res.status).toBe(401)
  })

  it('refuses a tampered and an expired token', async () => {
    const { artifact } = seedArtifact(`${fence}html\n<p>x</p>\n${fence}`)
    const minted = mintArtifactToken(artifact.id, 1)
    const tampered = `${minted.token.slice(0, -2)}xy`
    expect((await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content?t=${encodeURIComponent(tampered)}`)).status).toBe(401)

    const expired = mintArtifactToken(artifact.id, 1, -10)
    expect((await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content?t=${encodeURIComponent(expired.token)}`)).status).toBe(401)
  })

  it('refuses a capability token issued for another user', async () => {
    const { artifact } = seedArtifact(`${fence}html\n<p>x</p>\n${fence}`)
    const minted = mintArtifactToken(artifact.id, 2)
    const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content?t=${encodeURIComponent(minted.token)}`)
    expect(res.status).toBe(404)
  })

  it('accepts a bearer token for programmatic clients but not from another user', async () => {
    const { artifact } = seedArtifact(`${fence}html\n<p>bytes</p>\n${fence}`)
    const mine = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(mine.status).toBe(200)
    expect(await mine.text()).toBe('<p>bytes</p>')

    const theirs = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(theirs.status).toBe(404)
  })
})

describe('GET /api/chat/history', () => {
  it('carries the artifact references so no client has to parse markdown', async () => {
    const { messageId, artifact } = seedArtifact(`Kurz: hier der Chart.\n${fence}html Chart\n<h1>c</h1>\n${fence}`)
    seedMessage('Eine Nachricht ohne Canvas.')

    const res = await fetch(`${baseUrl}/api/chat/history?session_id=${STRAND}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: number; content: string; artifacts: ArtifactRefBody[] }> }

    const withCanvas = body.messages.find(m => m.id === messageId)!
    expect(withCanvas.artifacts).toHaveLength(1)
    expect(withCanvas.artifacts[0]).toMatchObject({ id: artifact.id, kind: 'html', title: 'Chart', messageId })
    // The fence stays in the message text for Telegram and the web fallback.
    expect(withCanvas.content).toContain('```html Chart')

    const plain = body.messages.find(m => m.id !== messageId)!
    expect(plain.artifacts).toEqual([])
  })

  it('does not leak another user artifacts into their history', async () => {
    seedArtifact(`${fence}html Fremd\n<p>x</p>\n${fence}`)
    seedMessage('Nachricht von user 2', STRAND, 2)
    const res = await fetch(`${baseUrl}/api/chat/history?session_id=${STRAND}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    const body = await res.json() as { messages: Array<{ artifacts: unknown[] }> }
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]!.artifacts).toEqual([])
  })
})
