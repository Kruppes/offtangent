import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@axiom/core'
import { ensureConfigTemplates, initDatabase, setActiveProvider } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined
let settingsPath: string
let providersPath: string

const ANTHROPIC = 'prov-anthropic'
const OLLAMA = 'prov-ollama'
const KIMI = 'prov-kimi'

const providersFile = {
  providers: [
    {
      id: ANTHROPIC,
      name: 'Anthropic',
      type: 'anthropic-messages',
      providerType: 'anthropic-oauth',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-not-a-real-key',
      enabledModels: ['claude-opus-5', 'claude-sonnet-5'],
    },
    {
      id: OLLAMA,
      name: 'ollama',
      type: 'openai-completions',
      providerType: 'ollama',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      enabledModels: ['qwen3.8:27b-mlx'],
    },
    {
      id: KIMI,
      name: 'Moonshot',
      type: 'openai-completions',
      providerType: 'kimi',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-kimi-not-a-real-key',
      enabledModels: ['kimi-k2.6'],
    },
  ],
  activeProvider: ANTHROPIC,
  activeModel: 'claude-opus-5',
}

function writeSettings(extra: Record<string, unknown>): void {
  const base = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  fs.writeFileSync(settingsPath, `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`, 'utf-8')
}

function readSettingsRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-model-policy-route-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  ensureConfigTemplates()
  settingsPath = path.join(tempDataDir, 'config', 'settings.json')
  providersPath = path.join(tempDataDir, 'config', 'providers.json')
  fs.writeFileSync(providersPath, `${JSON.stringify(providersFile, null, 2)}\n`, 'utf-8')

  db = initDatabase(':memory:')
  server = http.createServer(createApp({ db }))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.writeFileSync(providersPath, `${JSON.stringify(providersFile, null, 2)}\n`, 'utf-8')
  writeSettings({
    modelPolicy: {
      version: 1,
      roles: {
        router: `${ANTHROPIC}:claude-sonnet-5, ${OLLAMA}:qwen3.8:27b-mlx`,
        'task:cronjob': `${ANTHROPIC}:claude-sonnet-5`,
      },
    },
    sessionSummaryProviderId: `${OLLAMA}:qwen3.8:27b-mlx`,
    tasks: { defaultProvider: `${ANTHROPIC}:claude-opus-5` },
  })
})

describe('GET /api/model-policy', () => {
  it('requires admin', async () => {
    const anon = await fetch(`${baseUrl}/api/model-policy`)
    expect(anon.status).toBe(401)

    const nonAdmin = await fetch(`${baseUrl}/api/model-policy`, { headers: authHeaders(userToken) })
    expect(nonAdmin.status).toBe(403)
  })

  it('returns roles, the read-only default and the per-role resolution', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy`, { headers: authHeaders(adminToken) })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      roles: Record<string, string>
      default: { providerId: string; modelId: string; composite: string } | null
      policy: Array<{ role: string; value: string; source: string; resolved: unknown; warning?: string }>
    }

    expect(body.roles['task:cronjob']).toBe(`${ANTHROPIC}:claude-sonnet-5`)
    expect(body.default).toEqual({
      providerId: ANTHROPIC,
      providerName: 'Anthropic',
      modelId: 'claude-opus-5',
      composite: `${ANTHROPIC}:claude-opus-5`,
    })

    const cronjob = body.policy.find(entry => entry.role === 'task:cronjob')
    expect(cronjob?.resolved).toEqual({ providerId: ANTHROPIC, providerName: 'Anthropic', modelId: 'claude-sonnet-5' })
    expect(cronjob?.source).toBe('role')

    // Legacy read-through is visible in the payload.
    const summary = body.policy.find(entry => entry.role === 'summary')
    expect(summary?.source).toBe('legacy')
    expect(summary?.resolved).toEqual({ providerId: OLLAMA, providerName: 'ollama', modelId: 'qwen3.8:27b-mlx' })

    // Unset roles report "inherits".
    const heartbeat = body.policy.find(entry => entry.role === 'task:heartbeat')
    expect(heartbeat).toMatchObject({ value: '', source: 'active', resolved: null })
  })

  it('never leaks provider secrets', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy`, { headers: authHeaders(adminToken) })
    const text = await res.text()
    expect(text).not.toContain('sk-test-not-a-real-key')
    expect(text).not.toContain('sk-kimi-not-a-real-key')
    expect(text.toLowerCase()).not.toContain('apikey')
  })

  it('warns about a dead reference instead of failing', async () => {
    writeSettings({ modelPolicy: { version: 1, roles: { speechSummary: 'ghost-provider:ghost-model' } } })
    const res = await fetch(`${baseUrl}/api/model-policy`, { headers: authHeaders(adminToken) })
    const body = await res.json() as { policy: Array<{ role: string; resolved: unknown; warning?: string }> }
    const role = body.policy.find(entry => entry.role === 'speechSummary')
    expect(res.status).toBe(200)
    expect(role?.resolved).toBeNull()
    expect(role?.warning).toContain('ghost-provider')
  })
})

describe('PUT /api/model-policy', () => {
  it('requires admin', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(userToken),
      body: JSON.stringify({ roles: {} }),
    })
    expect(res.status).toBe(403)
  })

  it('writes only the modelPolicy block', async () => {
    const before = readSettingsRaw()
    const res = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        roles: {
          'task:consolidation': `${ANTHROPIC}:claude-opus-5`,
          projectAssignment: `${ANTHROPIC}:claude-sonnet-5, ${OLLAMA}:qwen3.8:27b-mlx`,
        },
      }),
    })
    expect(res.status).toBe(200)

    const after = readSettingsRaw()
    expect((after.modelPolicy as { roles: Record<string, string> }).roles).toEqual({
      'task:consolidation': `${ANTHROPIC}:claude-opus-5`,
      projectAssignment: `${ANTHROPIC}:claude-sonnet-5, ${OLLAMA}:qwen3.8:27b-mlx`,
    })
    for (const key of Object.keys(before)) {
      if (key === 'modelPolicy') continue
      expect(after[key]).toEqual(before[key])
    }
  })

  it('rejects the read-only default role with 400 default_is_read_only', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ roles: { default: `${ANTHROPIC}:claude-opus-5` } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { code: string }).code).toBe('default_is_read_only')
  })

  it('rejects blocked provider types', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ roles: { speechSummary: `${KIMI}:kimi-k2.6` } }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string; error: string }
    expect(body.code).toBe('unresolvable_reference')
    expect(body.error).toContain('not allowed')
  })

  it('rejects unknown references and chains on single-entry roles', async () => {
    const dead = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ roles: { 'task:cronjob': 'nope:nothing' } }),
    })
    expect(dead.status).toBe(400)
    expect((await dead.json() as { code: string }).code).toBe('unresolvable_reference')

    const chain = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ roles: { 'task:cronjob': `${ANTHROPIC}:claude-sonnet-5, ${OLLAMA}:qwen3.8:27b-mlx` } }),
    })
    expect(chain.status).toBe(400)
    expect((await chain.json() as { code: string }).code).toBe('chain_not_allowed')
  })

  it('accepts a chain on chain roles and drops empty roles', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        roles: {
          router: `${ANTHROPIC}:claude-sonnet-5, ${OLLAMA}:qwen3.8:27b-mlx`,
          'task:heartbeat': '   ',
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { roles: Record<string, string> }
    expect(body.roles.router).toBe(`${ANTHROPIC}:claude-sonnet-5, ${OLLAMA}:qwen3.8:27b-mlx`)
    expect(body.roles['task:heartbeat']).toBeUndefined()
  })
})

describe('GET /api/model-policy/resolve', () => {
  it('returns the full task chain with the taken step', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy/resolve?role=task:cronjob&kind=cronjob`, {
      headers: authHeaders(adminToken),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      steps: Array<{ step: string; value: string | null; taken: boolean; reason: string }>
      resolved: { modelId: string } | null
    }
    expect(body.resolved).toEqual({ providerId: ANTHROPIC, providerName: 'Anthropic', modelId: 'claude-sonnet-5' })
    const taken = body.steps.filter(step => step.taken)
    expect(taken).toHaveLength(1)
    expect(taken[0]!.step).toBe('modelPolicy.roles["task:cronjob"]')
    expect(body.steps.map(step => step.step)).toContain('tasks.defaultProvider')
    expect(body.steps[0]!.step).toContain('explicit')
  })

  it('falls through to tasks.defaultProvider when no role matches', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy/resolve?role=task:user&kind=user`, {
      headers: authHeaders(adminToken),
    })
    const body = await res.json() as { resolved: { modelId: string } | null; steps: Array<{ step: string; taken: boolean }> }
    expect(body.resolved).toEqual({ providerId: ANTHROPIC, providerName: 'Anthropic', modelId: 'claude-opus-5' })
    expect(body.steps.find(step => step.taken)?.step).toBe('tasks.defaultProvider')
  })

  it('explains the legacy read-through of a background role', async () => {
    const res = await fetch(`${baseUrl}/api/model-policy/resolve?role=summary`, { headers: authHeaders(adminToken) })
    const body = await res.json() as { steps: Array<{ step: string; taken: boolean }> }
    expect(body.steps.find(step => step.taken)?.step).toBe('legacy sessionSummaryProviderId')
  })

  it('ends on the active provider when nothing is configured', async () => {
    writeSettings({ modelPolicy: { version: 1, roles: {} }, sessionSummaryProviderId: '', tasks: { defaultProvider: '' } })
    const res = await fetch(`${baseUrl}/api/model-policy/resolve?role=summary`, { headers: authHeaders(adminToken) })
    const body = await res.json() as { resolved: { modelId: string } | null; steps: Array<{ step: string; taken: boolean }> }
    expect(body.steps.find(step => step.taken)?.step).toBe('active provider (default role)')
    expect(body.resolved).toEqual({ providerId: ANTHROPIC, providerName: 'Anthropic', modelId: 'claude-opus-5' })
  })

  it('requires the role parameter and admin', async () => {
    const missing = await fetch(`${baseUrl}/api/model-policy/resolve`, { headers: authHeaders(adminToken) })
    expect(missing.status).toBe(400)
    expect((await missing.json() as { code: string }).code).toBe('role_required')

    const nonAdmin = await fetch(`${baseUrl}/api/model-policy/resolve?role=router`, { headers: authHeaders(userToken) })
    expect(nonAdmin.status).toBe(403)
  })
})

describe('invariant: a model switch never touches modelPolicy', () => {
  it('survives setActiveProvider byte-identically', async () => {
    await fetch(`${baseUrl}/api/model-policy`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ roles: { 'task:consolidation': `${ANTHROPIC}:claude-opus-5` } }),
    })
    const before = fs.readFileSync(settingsPath, 'utf-8')
    const beforeBlock = JSON.stringify(readSettingsRaw().modelPolicy)

    setActiveProvider(OLLAMA, 'qwen3.8:27b-mlx')

    const providersAfter = JSON.parse(fs.readFileSync(providersPath, 'utf-8')) as { activeProvider: string }
    expect(providersAfter.activeProvider).toBe(OLLAMA)
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(before)
    expect(JSON.stringify(readSettingsRaw().modelPolicy)).toBe(beforeBlock)

    // The derived default role follows the switch, the roles do not.
    const res = await fetch(`${baseUrl}/api/model-policy`, { headers: authHeaders(adminToken) })
    const body = await res.json() as { roles: Record<string, string>; default: { composite: string } | null }
    expect(body.default?.composite).toBe(`${OLLAMA}:qwen3.8:27b-mlx`)
    expect(body.roles['task:consolidation']).toBe(`${ANTHROPIC}:claude-opus-5`)
  })

  it('survives a PUT /api/settings without a modelPolicy block', async () => {
    const beforeBlock = JSON.stringify(readSettingsRaw().modelPolicy)

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ sessionTimeoutMinutes: 45 }),
    })
    expect(res.status).toBe(200)

    const after = readSettingsRaw()
    expect(after.sessionTimeoutMinutes).toBe(45)
    expect(JSON.stringify(after.modelPolicy)).toBe(beforeBlock)
  })

  it('ignores a modelPolicy block sent to PUT /api/settings (only /api/model-policy writes it)', async () => {
    const beforeBlock = JSON.stringify(readSettingsRaw().modelPolicy)

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ modelPolicy: { roles: { 'task:consolidation': `${KIMI}:kimi-k2.6` } } }),
    })
    expect(res.status).toBe(200)
    expect(JSON.stringify(readSettingsRaw().modelPolicy)).toBe(beforeBlock)
  })
})
