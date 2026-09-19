import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@axiom/core'
import { initDatabase } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

const restartHealthMonitor = vi.fn()

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-providers-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  server = http.createServer(createApp({
    db,
    healthMonitorService: {
      restart: restartHealthMonitor,
    } as unknown as NonNullable<Parameters<typeof createApp>[0]>['healthMonitorService'],
  }))

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`

  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  restartHealthMonitor.mockClear()
})

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('providers route module', () => {
  it('enforces authentication and admin boundary', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/providers`)
    expect(unauthenticated.status).toBe(401)

    const nonAdmin = await fetch(`${baseUrl}/api/providers`, {
      headers: authHeaders(userToken),
    })
    expect(nonAdmin.status).toBe(403)
  })

  it('keeps provider listing, update flow, and activation semantics stable', async () => {
    const firstCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider One',
        providerType: 'openai',
        apiKey: 'sk-provider-one',
        enabledModels: ['gpt-4o-mini'],
      }),
    })

    expect(firstCreate.status).toBe(201)
    const firstBody = await firstCreate.json() as {
      provider: { id: string; name: string; apiKey: string; apiKeyMasked: string }
    }
    expect(firstBody.provider.name).toBe('Provider One')
    expect(firstBody.provider.apiKey).toBe('')
    expect(firstBody.provider.apiKeyMasked).toContain('••••••••')

    const secondCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider Two',
        providerType: 'openai',
        apiKey: 'sk-provider-two',
        enabledModels: ['gpt-4o-mini'],
      }),
    })

    expect(secondCreate.status).toBe(201)
    const secondBody = await secondCreate.json() as { provider: { id: string; name: string } }

    const listBeforeUpdate = await fetch(`${baseUrl}/api/providers`, {
      headers: authHeaders(adminToken),
    })
    expect(listBeforeUpdate.status).toBe(200)
    const listBeforeUpdateBody = await listBeforeUpdate.json() as {
      providers: Array<{ id: string; name: string }>
      activeProvider: string | null
      activeModel: string | null
      presets: Record<string, unknown>
    }

    expect(listBeforeUpdateBody.providers).toHaveLength(2)
    expect(listBeforeUpdateBody.activeProvider).toBe(firstBody.provider.id)
    expect(listBeforeUpdateBody.activeModel).toBe('gpt-4o-mini')
    expect(listBeforeUpdateBody.presets['ollama-local']).toBeUndefined()
    expect(listBeforeUpdateBody.presets['ollama-cloud']).toBeUndefined()

    const updateResponse = await fetch(`${baseUrl}/api/providers/${secondBody.provider.id}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider Two Updated',
        enabledModels: ['gpt-4o-mini'],
      }),
    })

    expect(updateResponse.status).toBe(200)
    const updateBody = await updateResponse.json() as {
      provider: { id: string; name: string; apiKeyMasked: string }
    }
    expect(updateBody.provider.id).toBe(secondBody.provider.id)
    expect(updateBody.provider.name).toBe('Provider Two Updated')
    expect(updateBody.provider.apiKeyMasked).toBe('(unchanged)')

    const activationResponse = await fetch(`${baseUrl}/api/providers/${secondBody.provider.id}/activate`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId: 'gpt-4o-mini' }),
    })

    expect(activationResponse.status).toBe(200)
    const activationBody = await activationResponse.json() as {
      activeProvider: string
      activeModel: string | null
    }
    expect(activationBody.activeProvider).toBe(secondBody.provider.id)
    expect(activationBody.activeModel).toBe('gpt-4o-mini')

    const listAfterActivation = await fetch(`${baseUrl}/api/providers`, {
      headers: authHeaders(adminToken),
    })
    const listAfterActivationBody = await listAfterActivation.json() as {
      activeProvider: string | null
      activeModel: string | null
    }
    expect(listAfterActivationBody.activeProvider).toBe(secondBody.provider.id)
    expect(listAfterActivationBody.activeModel).toBe('gpt-4o-mini')

    expect(restartHealthMonitor).toHaveBeenCalled()

    const setFallback = await fetch(`${baseUrl}/api/providers/fallback`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: firstBody.provider.id, modelId: 'gpt-4o-mini' }),
    })
    expect(setFallback.status).toBe(200)
    expect(await setFallback.json()).toMatchObject({
      fallbackProvider: firstBody.provider.id,
      fallbackModel: 'gpt-4o-mini',
    })

    const clearFallback = await fetch(`${baseUrl}/api/providers/fallback`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: null }),
    })
    expect(clearFallback.status).toBe(200)
    expect(await clearFallback.json()).toMatchObject({
      fallbackProvider: null,
      fallbackModel: null,
    })
  })

  it('keeps provider validation and not-found responses stable', async () => {
    const invalidCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Invalid Provider',
        providerType: 'invalid-provider',
        enabledModels: ['model'],
      }),
    })

    expect(invalidCreate.status).toBe(400)
    expect(await invalidCreate.json()).toEqual({
      error: expect.stringContaining('Invalid provider type. Must be one of:'),
    })

    const invalidFallback = await fetch(`${baseUrl}/api/providers/fallback`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: '' }),
    })

    expect(invalidFallback.status).toBe(400)
    expect(await invalidFallback.json()).toEqual({
      error: 'providerId must be a non-empty string or null',
    })

    const activateMissing = await fetch(`${baseUrl}/api/providers/missing-provider/activate`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    })
    expect(activateMissing.status).toBe(404)

    const testMissing = await fetch(`${baseUrl}/api/providers/missing-provider/test`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    })
    expect(testMissing.status).toBe(404)
    expect(await testMissing.json()).toEqual({ error: 'Provider not found' })
  })

  it('serves live models only for dynamic-catalog providers', async () => {
    const dynamicMissing = await fetch(`${baseUrl}/api/providers/missing-provider/live-models`, {
      headers: authHeaders(adminToken),
    })
    expect(dynamicMissing.status).toBe(404)

    const staticCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Static Catalog Provider',
        providerType: 'openai',
        apiKey: 'sk-static-catalog',
        enabledModels: ['gpt-4o-mini'],
      }),
    })
    expect(staticCreate.status).toBe(201)
    const staticProvider = await staticCreate.json() as { provider: { id: string } }

    const staticLive = await fetch(`${baseUrl}/api/providers/${staticProvider.provider.id}/live-models`, {
      headers: authHeaders(adminToken),
    })
    expect(staticLive.status).toBe(400)
    expect(await staticLive.json()).toEqual({
      error: 'Provider type does not use a dynamic catalog',
    })
  })

  it('patches a model description and cost via the model edit endpoint', async () => {
    const create = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Model Edit Provider',
        providerType: 'openai',
        apiKey: 'sk-model-edit',
        enabledModels: ['gpt-4o-mini', 'gpt-4o'],
      }),
    })
    expect(create.status).toBe(201)
    const created = await create.json() as { provider: { id: string } }

    const patch = await fetch(
      `${baseUrl}/api/providers/${created.provider.id}/models/${encodeURIComponent('gpt-4o')}`,
      {
        method: 'PATCH',
        headers: {
          ...authHeaders(adminToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: 'Strong model for complex analysis',
          cost: { input: 2.5, output: 10, cacheRead: 1.25 },
        }),
      },
    )
    expect(patch.status).toBe(200)
    const patched = await patch.json() as {
      provider: { models?: Array<{ id: string; description?: string; cost?: { input: number; output: number; cacheRead?: number } }> }
    }
    const entry = patched.provider.models?.find(m => m.id === 'gpt-4o')
    expect(entry).toBeDefined()
    expect(entry?.description).toBe('Strong model for complex analysis')
    expect(entry?.cost?.input).toBe(2.5)
    expect(entry?.cost?.output).toBe(10)
    expect(entry?.cost?.cacheRead).toBe(1.25)

    // Clearing the description and leaving cost untouched
    const clearPatch = await fetch(
      `${baseUrl}/api/providers/${created.provider.id}/models/${encodeURIComponent('gpt-4o')}`,
      {
        method: 'PATCH',
        headers: {
          ...authHeaders(adminToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: '   ' }),
      },
    )
    expect(clearPatch.status).toBe(200)
    const cleared = await clearPatch.json() as {
      provider: { models?: Array<{ id: string; description?: string; cost?: { input: number } }> }
    }
    const clearedEntry = cleared.provider.models?.find(m => m.id === 'gpt-4o')
    expect(clearedEntry?.description).toBeUndefined()
    // Cost persisted from the previous patch
    expect(clearedEntry?.cost?.input).toBe(2.5)

    // Empty payload is rejected
    const empty = await fetch(
      `${baseUrl}/api/providers/${created.provider.id}/models/${encodeURIComponent('gpt-4o')}`,
      {
        method: 'PATCH',
        headers: {
          ...authHeaders(adminToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    )
    expect(empty.status).toBe(400)

    // Unknown provider → 404
    const missing = await fetch(
      `${baseUrl}/api/providers/no-such-provider/models/gpt-4o`,
      {
        method: 'PATCH',
        headers: {
          ...authHeaders(adminToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'x' }),
      },
    )
    expect(missing.status).toBe(404)
  })
})
