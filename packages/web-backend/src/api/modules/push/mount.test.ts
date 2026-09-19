/** The push router is actually mounted by createApp, not just exported. */
import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'user')
  server = http.createServer(createApp({ db }))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
})

it('answers /api/push/devices behind the app', async () => {
  const token = generateAccessToken({ userId: 1, username: 'alice', role: 'user' })
  const response = await fetch(`${baseUrl}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ token: 'tok-mounted', appVersion: '0.7.3' }),
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { device: { platform: string } }
  expect(body.device.platform).toBe('android')
})
