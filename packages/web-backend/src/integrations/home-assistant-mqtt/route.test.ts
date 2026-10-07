import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { generateAccessToken } from '../../auth.js'
import { createHomeAssistantMqttRouter } from './route.js'
let dir: string
let server: http.Server
let base: string
const previous = process.env.DATA_DIR
const calls: unknown[] = []
const stub = {
  getStatus: () => ({ status: 'off' }),
  apply: (settings: unknown) => calls.push(settings),
  test: async () => true,
}
const admin = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
const user = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
const req = (method: string, token?: string, body?: object, suffix = '') => fetch(`${base}/api/settings/mqtt${suffix}`, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.cwd(), '.mqtt-test-'))
  process.env.DATA_DIR = dir
  const app = express()
  app.use(express.json())
  app.use('/api/settings/mqtt', createHomeAssistantMqttRouter(stub as never))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous
  fs.rmSync(dir, { recursive: true, force: true })
})
describe('admin-only MQTT endpoints', () => {
  it('denies unauthenticated/non-admin reads and writes', async () => {
    expect((await req('GET')).status).toBe(401)
    expect((await req('GET', user)).status).toBe(403)
    expect((await req('PUT', user, { enabled: true, host: 'example.invalid' })).status).toBe(403)
    expect((await req('POST', user, {}, '/test')).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
  it('validates, saves and never returns password or handle', async () => {
    expect((await req('PUT', admin, { enabled: true })).status).toBe(400)
    const bad = await req('PUT', admin, { host: 'bad/path' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toBe(JSON.stringify({ error: 'Invalid MQTT settings' }))
    expect((await req('PUT', admin, { enabled: true, host: 'example.invalid', baseTopic: 'bad/#' })).status).toBe(400)
    const response = await req('PUT', admin, { enabled: true, host: 'example.invalid', password: 'only-in-test-not-a-secret' })
    expect(response.status).toBe(200)
    const data = await response.json() as Record<string, unknown>
    expect(data).toMatchObject({ enabled: true, host: 'example.invalid', passwordSet: true, status: 'off' })
    expect(JSON.stringify(data)).not.toMatch(/passwordSecret|only-in-test-not-a-secret/)
    expect(calls).toHaveLength(1)
    expect((await req('GET', admin)).status).toBe(200)
    expect((await req('POST', admin, {}, '/test')).status).toBe(200)
  })
  it('does not reveal filesystem paths when persisting fails', async () => {
    const write = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('/settings.json')) throw new Error('/private/example/settings.json')
      return write(file, ...args)
    })
    try {
      const response = await req('PUT', admin, { host: 'example.invalid' })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid MQTT settings' })
    } finally { spy.mockRestore() }
  })

})
