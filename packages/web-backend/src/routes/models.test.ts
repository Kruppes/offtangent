import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveProviders } from '@axiom/core'
import { generateAccessToken } from '../auth.js'
import { createModelsRouter } from './models.js'

let server: http.Server
let baseUrl = ''
let dataDir = ''
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-route-'))
  process.env.DATA_DIR = dataDir
  saveProviders({
    providers: [{
      id: 'openai', name: 'OpenAI', type: 'openai-completions', providerType: 'openai', provider: 'openai',
      baseUrl: 'https://example.invalid', apiKey: 'test-placeholder', enabledModels: ['good', 'bad'],
      modelStatuses: { good: 'connected', bad: 'error' },
      models: [{ id: 'good', name: 'Good model', contextWindow: 1234 }],
    }],
    activeProvider: 'openai', activeModel: 'good', fallbackProvider: 'openai', fallbackModel: 'good',
  })
  const app = express()
  app.use('/api/models', createModelsRouter(() => ({
    openai: { kind: 'openai-codex', windows: [{ key: 'weekly', label: '7d', utilization: 42, resetsAt: null, resetDisplay: 'absolute' }], fetchedAt: '2026-09-15T00:00:00Z' },
  })))
  server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('GET /api/models', () => {
  it('requires auth and returns a flat credential-free catalog including unavailable models and quota', async () => {
    expect((await fetch(`${baseUrl}/api/models`)).status).toBe(401)
    const token = generateAccessToken({ userId: 7, username: 'member', role: 'user' })
    const response = await fetch(`${baseUrl}/api/models`, { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    const body = await response.json() as { models: Array<Record<string, unknown>> }
    expect(body.models).toHaveLength(2)
    expect(body.models[0]).toMatchObject({ providerId: 'openai', modelId: 'good', displayName: 'Good model', contextWindow: 1234, status: 'connected', selectable: true, isActive: true, isFallback: true })
    expect(body.models[1]).toMatchObject({ modelId: 'bad', status: 'error', selectable: false })
    expect(JSON.stringify(body)).not.toContain('test-placeholder')
    expect(body.models[0]?.quota).toMatchObject({ windows: [{ utilization: 42 }] })
  })
})
