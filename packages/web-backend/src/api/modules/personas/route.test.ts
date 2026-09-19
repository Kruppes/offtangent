/**
 * Persona management over HTTP (SPEC 13.2, 13.3, 13.5, 13.7).
 *
 * What these tests pin down, in the order the user meets it: a persona can be
 * created with fields instead of markdown, the structured editor survives a
 * round trip without eating prose, archive is the removal that is always
 * available, a hard delete says what it would take and refuses while the
 * persona is answering, and the whole write path is admin-only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, getDefaultPersonaId } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

interface PersonaListItem {
  id: string
  displayName: string
  color: string | null
  badge: string | null
  role: string | null
  isDefault: boolean
  archived: boolean
  fileCount: number
  hasTelegramBinding: boolean
}

interface PersonaDetail {
  id: string
  files: Record<string, string>
  fields: {
    name: string | null
    badge: string | null
    color: string | null
    role: string | null
    tone: string | null
    model: string | null
    subjects: string[]
    tools: string[]
  }
  displayName: string
  color: string | null
  badge: string | null
  isDefault: boolean
  archived: boolean
}

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

/** The turn guard the app injects; flipped per test. */
let activeTurnAgent: string | null = null

/**
 * The persona service only ever calls `hasActiveTurnForAgent`. The app option
 * is typed as the union of the captures, strands and persona guards, so the
 * stub is widened once here instead of at every call site.
 */
type AppTurnRunner = Parameters<typeof createApp>[0] extends { getTurnRunner?: infer G }
  ? G extends () => infer R ? NonNullable<R> : never
  : never

const turnRunnerStub = {
  hasActiveTurnForAgent: (agentId: string) => activeTurnAgent === agentId,
} as unknown as AppTurnRunner

function agentsDir(): string {
  return path.join(tempDataDir, 'agents')
}

/** Whatever the endpoint answered: a typed shape per test, or an error body. */
type ResponseBody = Record<string, unknown> & { code?: string; error?: string }

async function call(
  method: string,
  url: string,
  body?: unknown,
  bearer: string = adminToken,
): Promise<{ status: number; body: ResponseBody }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed as ResponseBody }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-personas-route-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(agentsDir(), 'main'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir(), 'main', 'IDENTITY.md'), '# IDENTITY.md\n\n- **Name:** Main\n')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'user', 'x', 'user')

  const app = createApp({
    db,
    // Only the persona guard is exercised here; the captures/strands halves of
    // the injected runner are never reached by these routes, so the stub
    // carries the one method the persona service asks for.
    getTurnRunner: () => turnRunnerStub,
  })
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  activeTurnAgent = null
  // Every test starts from "main plus nothing", so ids do not collide.
  for (const entry of fs.readdirSync(agentsDir())) {
    if (entry !== 'main') fs.rmSync(path.join(agentsDir(), entry), { recursive: true, force: true })
  }
  db.prepare("DELETE FROM personas WHERE is_default = 0").run()
  db.prepare('DELETE FROM tasks').run()
})

describe('POST /api/personas', () => {
  it('creates a persona from structured fields and writes the markdown files', async () => {
    const created = await call('POST', '/api/personas', {
      id: 'scout',
      fields: {
        name: 'Scout',
        badge: '🧭',
        color: '#4F8EF7',
        role: 'Finds things out before anybody asks.',
        tone: 'short, no small talk',
        model: 'claude-sonnet-4-5',
        subjects: ['research', 'competitors'],
        tools: ['web_search', 'web_fetch'],
      },
    })

    expect(created.status).toBe(201)
    const detail = created.body as unknown as PersonaDetail
    expect(detail.id).toBe('scout')
    expect(detail.displayName).toBe('Scout')
    expect(detail.badge).toBe('🧭')
    // Colour is normalised to lowercase on the way in.
    expect(detail.color).toBe('#4f8ef7')
    expect(detail.fields.role).toBe('Finds things out before anybody asks.')
    expect(detail.fields.subjects).toEqual(['research', 'competitors'])
    expect(detail.fields.tools).toEqual(['web_search', 'web_fetch'])
    expect(detail.isDefault).toBe(false)
    expect(detail.archived).toBe(false)

    // The five markdown files really exist on disk.
    const dir = path.join(agentsDir(), 'scout')
    for (const file of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md']) {
      expect(fs.existsSync(path.join(dir, file))).toBe(true)
    }
    const identity = fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf-8')
    expect(identity).toContain('- **Name:** Scout')
    expect(identity).toContain('- **Emoji:** 🧭')
    expect(identity).toContain('- **Color:** #4f8ef7')
    expect(identity).toContain('- research')
    const toolsFile = fs.readFileSync(path.join(dir, 'TOOLS.md'), 'utf-8')
    expect(toolsFile).toContain('- web_search')
    // The template prose is still there — the fields did not replace the file.
    expect(toolsFile).toContain('Verfügbare Werkzeuge')
  })

  it('appears in the list with its rendered identity', async () => {
    await call('POST', '/api/personas', { id: 'scout', fields: { name: 'Scout', badge: '🧭', color: '#4f8ef7', role: 'Researcher.' } })
    const list = await call('GET', '/api/personas')
    expect(list.status).toBe(200)
    const scout = (list.body as unknown as PersonaListItem[]).find(p => p.id === 'scout')
    expect(scout).toMatchObject({
      id: 'scout', displayName: 'Scout', badge: '🧭', color: '#4f8ef7', role: 'Researcher.', isDefault: false, archived: false,
    })
    // The default persona sorts first, whatever it is called.
    expect((list.body as unknown as PersonaListItem[])[0]?.id).toBe(getDefaultPersonaId(db))
  })

  it('refuses a duplicate id with 409 persona_exists', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    const again = await call('POST', '/api/personas', { id: 'scout' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('persona_exists')
  })

  it('rejects a path traversal id without touching the filesystem', async () => {
    for (const id of ['../evil', '..', 'a/../../b', 'foo/bar', 'foo\\bar', 'main/../main']) {
      const res = await call('POST', '/api/personas', { id })
      expect(res.status, `id ${id}`).toBe(400)
      expect(res.body.code, `id ${id}`).toBe('invalid_body')
    }
    // Nothing was created next to the agents directory.
    expect(fs.existsSync(path.join(tempDataDir, 'evil'))).toBe(false)
    expect(fs.readdirSync(agentsDir())).toEqual(['main'])
  })

  it('rejects a traversal id on every :id route', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await call(method, '/api/personas/..%2f..%2fetc', method === 'PUT' ? { archived: true } : undefined)
      expect(res.status, method).toBe(400)
      expect(res.body.code, method).toBe('invalid_id')
    }
  })

  it('rejects a field value that would break the markdown line', async () => {
    const res = await call('POST', '/api/personas', { id: 'sneaky', fields: { role: 'line one\n- **Name:** Injected' } })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_body')
    expect(fs.existsSync(path.join(agentsDir(), 'sneaky'))).toBe(false)
  })
})

describe('PUT /api/personas/:id', () => {
  it('round-trips markdown → fields → markdown without losing anything', async () => {
    // A persona whose files carry hand written prose and non-canonical labels.
    const dir = path.join(agentsDir(), 'legacy')
    fs.mkdirSync(dir, { recursive: true })
    const identity = [
      '# IDENTITY.md',
      '',
      '- **Name:** Warren',
      '- **Creature:** KI-Anlageberater',
      '- **Vibe:** Fundiert, direkt',
      '- **Emoji:** 📈',
      '- **Avatar:** —',
      '',
      'Handgeschriebene Prosa, die niemand anfassen darf.',
      '',
      '## Eigene Sektion',
      '',
      'Noch mehr Text.',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'IDENTITY.md'), identity)
    fs.writeFileSync(path.join(dir, 'TOOLS.md'), '# TOOLS.md\n\nFreitext über Werkzeuge.\n')

    const before = await call('GET', `/api/personas/legacy`)
    expect(before.status).toBe(200)
    const fields = (before.body as unknown as PersonaDetail).fields
    // The non-canonical labels are understood.
    expect(fields.name).toBe('Warren')
    expect(fields.role).toBe('KI-Anlageberater')
    expect(fields.tone).toBe('Fundiert, direkt')
    expect(fields.badge).toBe('📈')

    // Writing back exactly what was read must not change a single byte.
    const written = await call('PUT', '/api/personas/legacy', { fields })
    expect(written.status).toBe(200)
    expect(fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf-8')).toBe(identity)
    expect((written.body as unknown as PersonaDetail).fields).toEqual(fields)
  })

  it('edits one field and leaves the rest of the file alone', async () => {
    const dir = path.join(agentsDir(), 'legacy')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'IDENTITY.md'),
      '# IDENTITY.md\n\n- **Name:** Warren\n- **Creature:** Anlageberater\n\nProsa bleibt.\n',
    )

    const res = await call('PUT', '/api/personas/legacy', { fields: { name: 'Warren Buffet' } })
    expect(res.status).toBe(200)
    const identity = fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf-8')
    expect(identity).toBe('# IDENTITY.md\n\n- **Name:** Warren Buffet\n- **Creature:** Anlageberater\n\nProsa bleibt.\n')
    expect((res.body as unknown as PersonaDetail).displayName).toBe('Warren Buffet')

    // The rendered identity also reached the record, so a client sees it
    // without parsing markdown.
    const record = db.prepare('SELECT display_name FROM personas WHERE id = ?').get('legacy') as { display_name: string }
    expect(record.display_name).toBe('Warren Buffet')
  })

  it('writes raw files in advanced mode and lets fields win in the same request', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    const res = await call('PUT', '/api/personas/scout', {
      files: { soul: '# SOUL.md\n\nKomplett neu.\n', identity: '# IDENTITY.md\n\n- **Name:** Roh\n' },
      fields: { name: 'Strukturiert' },
    })
    expect(res.status).toBe(200)
    const detail = res.body as unknown as PersonaDetail
    expect(detail.files.soul).toBe('# SOUL.md\n\nKomplett neu.\n')
    expect(detail.displayName).toBe('Strukturiert')
    expect(detail.files.identity).toContain('- **Name:** Strukturiert')
  })

  it('archives and restores a persona', async () => {
    await call('POST', '/api/personas', { id: 'scout', fields: { name: 'Scout' } })

    const archived = await call('PUT', '/api/personas/scout', { archived: true })
    expect(archived.status).toBe(200)
    expect((archived.body as unknown as PersonaDetail).archived).toBe(true)
    // Archiving keeps every file — that is the whole point of it.
    expect(fs.existsSync(path.join(agentsDir(), 'scout', 'SOUL.md'))).toBe(true)

    // An archived persona disappears from the picker but not from the admin list.
    const client = await call('GET', '/api/personas/client', undefined, userToken)
    expect((client.body.personas as { id: string }[]).map(p => p.id)).not.toContain('scout')
    const list = await call('GET', '/api/personas')
    expect((list.body as unknown as PersonaListItem[]).find(p => p.id === 'scout')?.archived).toBe(true)

    const restored = await call('PUT', '/api/personas/scout', { archived: false })
    expect((restored.body as unknown as PersonaDetail).archived).toBe(false)
    const clientAgain = await call('GET', '/api/personas/client', undefined, userToken)
    expect((clientAgain.body.personas as { id: string }[]).map(p => p.id)).toContain('scout')
  })

  it('refuses to archive while a turn of that persona runs (409 persona_busy)', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    activeTurnAgent = 'scout'
    const res = await call('PUT', '/api/personas/scout', { archived: true })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('persona_busy')
  })

  it('rejects an empty body instead of writing files for nothing', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    const res = await call('PUT', '/api/personas/scout', {})
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_body')
  })

  it('answers 404 for a persona that does not exist', async () => {
    const res = await call('PUT', '/api/personas/nobody', { fields: { name: 'X' } })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('persona_not_found')
  })
})

describe('the default persona flag (SPEC 13.2)', () => {
  it('moves the flag to another persona and keeps exactly one default', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    const promoted = await call('PUT', '/api/personas/scout', { isDefault: true })
    expect(promoted.status).toBe(200)
    expect((promoted.body as unknown as PersonaDetail).isDefault).toBe(true)

    expect(getDefaultPersonaId(db)).toBe('scout')
    const flagged = db.prepare('SELECT COUNT(*) AS c FROM personas WHERE is_default = 1').get() as { c: number }
    expect(flagged.c).toBe(1)

    // The old default lost the flag and is now deletable...
    const list = await call('GET', '/api/personas')
    expect((list.body as unknown as PersonaListItem[]).find(p => p.id === 'main')?.isDefault).toBe(false)
    expect((list.body as unknown as PersonaListItem[])[0]?.id).toBe('scout')

    // ...while the new one is protected.
    const refused = await call('DELETE', '/api/personas/scout?confirm=1')
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('persona_is_default')

    // Restore for the following tests.
    await call('PUT', '/api/personas/main', { isDefault: true })
    expect(getDefaultPersonaId(db)).toBe('main')
  })

  it('refuses to clear the flag without naming a successor', async () => {
    const res = await call('PUT', `/api/personas/${getDefaultPersonaId(db)}`, { isDefault: false })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('default_required')
  })

  it('un-archives a persona that is promoted to default', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    await call('PUT', '/api/personas/scout', { archived: true })
    const promoted = await call('PUT', '/api/personas/scout', { isDefault: true })
    expect((promoted.body as unknown as PersonaDetail).archived).toBe(false)
    await call('PUT', '/api/personas/main', { isDefault: true })
  })
})

describe('DELETE /api/personas/:id', () => {
  it('previews what a hard delete would remove', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    db.prepare("INSERT INTO sessions (id, session_user, type, agent_id, source) VALUES ('s1', '1', 'interactive', 'scout', 'web')").run()
    db.prepare("INSERT INTO chat_messages (user_id, session_id, role, content, agent_id) VALUES (1, 's1', 'user', 'hi', 'scout')").run()
    db.prepare("INSERT INTO memories (user_id, content, agent_id) VALUES (1, 'a fact', 'scout')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, agent_id) VALUES ('t1', 'n', 'p', 'completed', 'user', 'scout')").run()
    db.prepare("INSERT INTO scheduled_tasks (id, name, prompt, schedule, agent_id) VALUES ('c1', 'n', 'p', '* * * * *', 'scout')").run()

    const preview = await call('GET', '/api/personas/scout/delete-preview')
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ personaId: 'scout', strands: 1, messages: 1, facts: 1, tasks: 1, cronjobs: 1 })
  })

  it('requires an explicit confirmation', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    const res = await call('DELETE', '/api/personas/scout')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('confirm_required')
    expect(fs.existsSync(path.join(agentsDir(), 'scout'))).toBe(true)
  })

  it('hard-deletes files and record with confirm=1', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    const res = await call('DELETE', '/api/personas/scout?confirm=1')
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(agentsDir(), 'scout'))).toBe(false)
    expect(db.prepare('SELECT 1 AS c FROM personas WHERE id = ?').get('scout')).toBeUndefined()
    const list = await call('GET', '/api/personas')
    expect((list.body as unknown as PersonaListItem[]).map(p => p.id)).not.toContain('scout')
  })

  it('refuses the delete with 409 persona_busy while a turn runs', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    activeTurnAgent = 'scout'
    const res = await call('DELETE', '/api/personas/scout?confirm=1')
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('persona_busy')
    expect(fs.existsSync(path.join(agentsDir(), 'scout'))).toBe(true)
  })

  it('refuses the delete with 409 persona_busy while a delegated task runs', async () => {
    await call('POST', '/api/personas', { id: 'scout' })
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, agent_id) VALUES ('t2', 'n', 'p', 'running', 'user', 'scout')").run()
    const res = await call('DELETE', '/api/personas/scout?confirm=1')
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('persona_busy')
  })

  it('refuses to delete the default persona', async () => {
    const res = await call('DELETE', `/api/personas/${getDefaultPersonaId(db)}?confirm=1`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('persona_is_default')
  })

  it('answers 404 for an unknown persona', async () => {
    const res = await call('DELETE', '/api/personas/nobody?confirm=1')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('persona_not_found')
  })
})

describe('who may change a persona (SPEC 13.7)', () => {
  it('locks every persona route behind an authenticated admin', async () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/personas'],
      ['POST', '/api/personas', { id: 'intruder' }],
      ['GET', '/api/personas/main'],
      ['PUT', '/api/personas/main', { fields: { name: 'Owned' } }],
      ['GET', '/api/personas/main/delete-preview'],
      ['DELETE', '/api/personas/main?confirm=1'],
    ]

    for (const [method, url, body] of routes) {
      const anonymous = await fetch(`${baseUrl}${url}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      expect(anonymous.status, `${method} ${url} anonymous`).toBe(401)

      const asUser = await call(method, url, body, userToken)
      expect(asUser.status, `${method} ${url} as user`).toBe(403)
      expect(asUser.body.code, `${method} ${url} as user`).toBe('forbidden')
    }

    // Nothing leaked through: the persona a non-admin tried to create is absent.
    expect(fs.existsSync(path.join(agentsDir(), 'intruder'))).toBe(false)
    // And main still carries its own name.
    const main = await call('GET', '/api/personas/main')
    expect((main.body as unknown as PersonaDetail).displayName).not.toBe('Owned')
  })

  it('never leaks a filesystem path or a stack trace in an error', async () => {
    const responses = [
      await call('GET', '/api/personas/nobody/delete-preview'),
      await call('DELETE', '/api/personas/nobody?confirm=1'),
      await call('PUT', '/api/personas/nobody', { fields: { name: 'X' } }),
      await call('POST', '/api/personas', { id: 'UPPERCASE' }),
      await call('PUT', '/api/personas/main', { fields: { color: 'not-a-colour' } }),
    ]
    for (const res of responses) {
      const text = JSON.stringify(res.body)
      expect(text).not.toContain(tempDataDir)
      expect(text).not.toContain('/data/agents')
      expect(text).not.toContain('at Object.')
      expect(text).not.toMatch(/\.ts:\d+/)
      expect(res.body.code).toBeTruthy()
    }
  })
})
