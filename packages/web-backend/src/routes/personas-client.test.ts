/**
 * GET /api/personas/client — the non-admin persona list the Android app uses
 * to label chats.
 *
 * What matters here: a normal user gets it (the admin router must not shadow
 * it), the projection leaks no operational detail, and a hand-edited
 * IDENTITY.md can never break the response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

interface ClientPersona {
  id: string
  displayName: string
  emoji: string | null
  color: string | null
}

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

function writePersona(id: string, identity?: string): void {
  const dir = path.join(tempDataDir, 'agents', id)
  fs.mkdirSync(dir, { recursive: true })
  if (identity !== undefined) fs.writeFileSync(path.join(dir, 'IDENTITY.md'), identity)
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-personas-client-'))
  process.env.DATA_DIR = tempDataDir

  writePersona('warren', '# IDENTITY.md\n\n- **Name:** Warren\n- **Creature:** KI-Anlageberater\n- **Emoji:** 📈\n- **Color:** #4F46E5\n')
  writePersona('bob', '# IDENTITY.md\n\n- **Name:** Bob\n- **Emoji:** 🔨\n- **Avatar:** —\n')
  // No IDENTITY.md at all.
  writePersona('ghost')
  // Junk file: must not throw, must fall back to the id.
  writePersona('broken', 'not markdown at all ***\n')
  // Placeholder emoji + an unusable colour.
  writePersona('placeholder', '- **Name:**   \n- **Emoji:** —\n- **Color:** blue\n')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'user', 'x', 'user')

  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

async function list(bearer: string): Promise<{ status: number; personas: ClientPersona[] }> {
  const res = await fetch(`${baseUrl}/api/personas/client`, { headers: { Authorization: `Bearer ${bearer}` } })
  const body = (await res.json()) as { personas?: ClientPersona[] }
  return { status: res.status, personas: body.personas ?? [] }
}

describe('GET /api/personas/client', () => {
  it('is available to a non-admin user with main first, then sorted by id', async () => {
    const { status, personas } = await list(userToken)
    expect(status).toBe(200)
    expect(personas.map(p => p.id)).toEqual(['main', 'bob', 'broken', 'ghost', 'placeholder', 'warren'])
  })

  it('parses name, emoji and colour from IDENTITY.md', async () => {
    const { personas } = await list(userToken)
    expect(personas.find(p => p.id === 'warren')).toEqual({
      id: 'warren', displayName: 'Warren', emoji: '📈', color: '#4f46e5', isDefault: false,
    })
    expect(personas.find(p => p.id === 'bob')).toEqual({
      id: 'bob', displayName: 'Bob', emoji: '🔨', color: null, isDefault: false,
    })
  })

  it('falls back to the id and to null for missing, junk or placeholder fields', async () => {
    const { personas } = await list(userToken)
    expect(personas.find(p => p.id === 'ghost')).toEqual({ id: 'ghost', displayName: 'ghost', emoji: null, color: null, isDefault: false })
    expect(personas.find(p => p.id === 'broken')).toEqual({ id: 'broken', displayName: 'broken', emoji: null, color: null, isDefault: false })
    expect(personas.find(p => p.id === 'placeholder')).toEqual({
      id: 'placeholder', displayName: 'placeholder', emoji: null, color: null, isDefault: false,
    })
    // `main` has no directory in this fixture and is still listed.
    expect(personas.find(p => p.id === 'main')).toEqual({ id: 'main', displayName: 'main', emoji: null, color: null, isDefault: true })
  })

  it('exposes no operational detail', async () => {
    const { personas } = await list(userToken)
    for (const persona of personas) {
      expect(Object.keys(persona).sort()).toEqual(['color', 'displayName', 'emoji', 'id', 'isDefault'])
    }
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/personas/client`)
    expect(res.status).toBe(401)
  })

  it('does not shadow the admin persona routes', async () => {
    const admins = await fetch(`${baseUrl}/api/personas`, { headers: { Authorization: `Bearer ${adminToken}` } })
    expect(admins.status).toBe(200)
    const list = (await admins.json()) as Array<{ id: string; fileCount: number }>
    expect(list.map(p => p.id)).toContain('warren')
    expect(list[0]).toHaveProperty('fileCount')

    // ...and the admin surface stays admin-only.
    const forbidden = await fetch(`${baseUrl}/api/personas`, { headers: { Authorization: `Bearer ${userToken}` } })
    expect(forbidden.status).toBe(403)
  })
})
