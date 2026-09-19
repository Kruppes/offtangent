import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './app.js'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { generateAccessToken } from './auth.js'

let db: Database
let server: http.Server
let port: number
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

async function apiFetch(urlPath: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers as Record<string, string> || {}),
  }
  return fetch(`${baseUrl}${urlPath}`, { ...options, headers })
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cronjobs-test-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address() as { port: number }
  port = addr.port
  baseUrl = `http://localhost:${port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir !== undefined) {
    process.env.DATA_DIR = previousDataDir
  } else {
    delete process.env.DATA_DIR
  }
})

describe('Cronjobs REST API', () => {
  let createdId: string

  describe('POST /api/cronjobs', () => {
    it('creates a new cronjob', async () => {
      const res = await apiFetch('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Daily Summary',
          prompt: 'Summarize the news',
          schedule: '0 9 * * *',
        }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as { cronjob: { id: string; name: string; schedule: string; scheduleHuman: string; enabled: boolean } }
      expect(body.cronjob.id).toBeTruthy()
      expect(body.cronjob.name).toBe('Daily Summary')
      expect(body.cronjob.schedule).toBe('0 9 * * *')
      expect(body.cronjob.scheduleHuman).toBeTruthy()
      expect(body.cronjob.enabled).toBe(true)
      createdId = body.cronjob.id
    })

    it('validates cron expression', async () => {
      const res = await apiFetch('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Bad Cron',
          prompt: 'test',
          schedule: 'invalid',
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('Invalid cron expression')
    })

    it('requires name, prompt, schedule', async () => {
      const res = await apiFetch('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify({ name: 'Only name' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('Missing required fields')
    })
  })

  describe('GET /api/cronjobs', () => {
    it('returns all cronjobs', async () => {
      const res = await apiFetch('/api/cronjobs')
      expect(res.status).toBe(200)
      const body = await res.json() as { cronjobs: { id: string }[] }
      expect(body.cronjobs.length).toBeGreaterThanOrEqual(1)
      expect(body.cronjobs[0]).toHaveProperty('scheduleHuman')
    })
  })

  describe('PUT /api/cronjobs/:id', () => {
    it('updates a cronjob', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'Updated Summary',
          schedule: '0 10 * * *',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { cronjob: { name: string; schedule: string } }
      expect(body.cronjob.name).toBe('Updated Summary')
      expect(body.cronjob.schedule).toBe('0 10 * * *')
    })

    it('validates cron expression on update', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ schedule: 'bad' }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 404 for non-existent id', async () => {
      const res = await apiFetch('/api/cronjobs/non-existent', {
        method: 'PUT',
        body: JSON.stringify({ name: 'New Name' }),
      })

      expect(res.status).toBe(404)
    })

    it('saves and returns override fields', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          toolsOverride: JSON.stringify(['shell', 'write_file']),
          skillsOverride: JSON.stringify(['brave-search']),
          systemPromptOverride: 'Custom system prompt for this cronjob.',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { cronjob: { toolsOverride: string; skillsOverride: string; systemPromptOverride: string } }
      expect(body.cronjob.toolsOverride).toBe(JSON.stringify(['shell', 'write_file']))
      expect(body.cronjob.skillsOverride).toBe(JSON.stringify(['brave-search']))
      expect(body.cronjob.systemPromptOverride).toBe('Custom system prompt for this cronjob.')
    })

    it('clears override fields when set to null', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          toolsOverride: null,
          skillsOverride: null,
          systemPromptOverride: null,
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { cronjob: { toolsOverride: string | null; skillsOverride: string | null; systemPromptOverride: string | null } }
      expect(body.cronjob.toolsOverride).toBeNull()
      expect(body.cronjob.skillsOverride).toBeNull()
      expect(body.cronjob.systemPromptOverride).toBeNull()
    })

    it('validates toolsOverride JSON format', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          toolsOverride: 'not-json',
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('toolsOverride')
    })

    it('validates toolsOverride must be array of strings', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          toolsOverride: JSON.stringify([1, 2, 3]),
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('array of strings')
    })

    it('validates skillsOverride JSON format', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          skillsOverride: '{bad}',
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('skillsOverride')
    })

    it('toggles enabled status', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { cronjob: { enabled: boolean } }
      expect(body.cronjob.enabled).toBe(false)
    })
  })

  describe('POST /api/cronjobs/:id/trigger', () => {
    it('returns 503 when no scheduler is available', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}/trigger`, {
        method: 'POST',
      })

      // No task scheduler configured in test app
      expect(res.status).toBe(503)
    })

    it('returns 404 for non-existent cronjob', async () => {
      const res = await apiFetch('/api/cronjobs/non-existent/trigger', {
        method: 'POST',
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/cronjobs/:id', () => {
    it('deletes a cronjob', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)

      // Verify it's gone
      const getRes = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Should Fail' }),
      })
      expect(getRes.status).toBe(404)
    })

    it('returns 404 for non-existent id', async () => {
      const res = await apiFetch('/api/cronjobs/non-existent', {
        method: 'DELETE',
      })

      expect(res.status).toBe(404)
    })
  })

  describe('JWT protection', () => {
    it('rejects requests without auth', async () => {
      const res = await fetch(`${baseUrl}/api/cronjobs`)
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/cronjobs/meta', () => {
    it('returns empty lists when no tool provider is wired and no skills exist', async () => {
      const res = await apiFetch('/api/cronjobs/meta')
      expect(res.status).toBe(200)
      const body = await res.json() as {
        tools: string[]
        installedSkills: unknown[]
        agentSkills: unknown[]
      }
      // No `getBackgroundTaskToolNames` wired on the test app → tools is empty.
      expect(Array.isArray(body.tools)).toBe(true)
      expect(body.tools).toEqual([])
      expect(Array.isArray(body.installedSkills)).toBe(true)
      expect(Array.isArray(body.agentSkills)).toBe(true)
    })

    it('surfaces the tool names provided by getBackgroundTaskToolNames', async () => {
      // Build a second app with the hook wired so we verify the plumbing end
      // to end. A fresh server avoids mutating the shared suite state.
      const wiredDb = initDatabase(':memory:')
      const wiredApp = createApp({
        db: wiredDb,
        getBackgroundTaskToolNames: () => ['shell', 'read_file', 'web_fetch'],
      })
      const wiredServer = http.createServer(wiredApp)
      await new Promise<void>((resolve) => wiredServer.listen(0, resolve))
      const wiredPort = (wiredServer.address() as { port: number }).port
      try {
        const res = await fetch(`http://localhost:${wiredPort}/api/cronjobs/meta`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { tools: string[] }
        expect(body.tools).toEqual(['shell', 'read_file', 'web_fetch'])
      } finally {
        await new Promise<void>((resolve, reject) => {
          wiredServer.close((err) => (err ? reject(err) : resolve()))
        })
        wiredDb.close()
      }
    })

    it('rejects requests without auth', async () => {
      const res = await fetch(`${baseUrl}/api/cronjobs/meta`)
      expect(res.status).toBe(401)
    })
  })
})
