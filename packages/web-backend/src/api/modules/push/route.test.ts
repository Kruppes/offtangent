/**
 * /api/push/devices (PROTOCOL chapter 7, slice 1) against a real router and
 * an in-memory database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createPushRouter } from './route.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string

interface ErrorBody { error: string; code: string }
interface Device { id: string; platform: string; appVersion: string | null; disabled: boolean }
interface DeviceBody { device: Device }
interface DeviceListBody { devices: Device[] }

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'user')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'bob', 'x', 'user')

  const app = express()
  app.use(express.json())
  app.use('/api/push', createPushRouter({ db }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'alice', role: 'user' })
  otherToken = generateAccessToken({ userId: 2, username: 'bob', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
})

beforeEach(() => {
  db.prepare('DELETE FROM push_devices').run()
})

function post(body: unknown, bearer = token) {
  return fetch(`${baseUrl}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
}

describe('POST /api/push/devices', () => {
  it('requires a token', async () => {
    const response = await post({})
    expect(response.status).toBe(400)
    expect((await response.json() as ErrorBody).code).toBe('token_required')
  })

  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/api/push/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-a' }),
    })
    expect(response.status).toBe(401)
  })

  it('registers a device and never echoes the token back', async () => {
    const response = await post({ token: 'tok-a', platform: 'android', appVersion: '0.7.3' })
    expect(response.status).toBe(200)
    const body = await response.json() as DeviceBody
    expect(body.device.platform).toBe('android')
    expect(body.device.appVersion).toBe('0.7.3')
    expect(body.device.disabled).toBe(false)
    expect(JSON.stringify(body)).not.toContain('tok-a')
  })

  it('rejects an unknown platform', async () => {
    const response = await post({ token: 'tok-a', platform: 'blackberry' })
    expect(response.status).toBe(400)
    expect((await response.json() as ErrorBody).code).toBe('invalid_platform')
  })

  it('is idempotent for the same token', async () => {
    const first = await (await post({ token: 'tok-a' })).json() as DeviceBody
    const second = await (await post({ token: 'tok-a' })).json() as DeviceBody
    expect(second.device.id).toBe(first.device.id)

    const list = await (await fetch(`${baseUrl}/api/push/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json() as DeviceListBody
    expect(list.devices).toHaveLength(1)
  })

  it('moves a token to the user who registered it last', async () => {
    await post({ token: 'tok-a' })
    await post({ token: 'tok-a' }, otherToken)

    const mine = await (await fetch(`${baseUrl}/api/push/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json() as DeviceListBody
    const theirs = await (await fetch(`${baseUrl}/api/push/devices`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    })).json() as DeviceListBody
    expect(mine.devices).toHaveLength(0)
    expect(theirs.devices).toHaveLength(1)
  })
})

describe('DELETE /api/push/devices/:token', () => {
  it('removes the caller\'s own device', async () => {
    await post({ token: 'tok-a' })
    const response = await fetch(`${baseUrl}/api/push/devices/tok-a`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(204)
  })

  it('does not remove a device of another user', async () => {
    await post({ token: 'tok-a' })
    const response = await fetch(`${baseUrl}/api/push/devices/tok-a`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(response.status).toBe(404)
    expect((await response.json() as ErrorBody).code).toBe('device_not_found')
  })

  it('decodes a url encoded token', async () => {
    await post({ token: 'tok/with+chars' }) // gitleaks:allow -- synthetic test fixture
    const response = await fetch(`${baseUrl}/api/push/devices/${encodeURIComponent('tok/with+chars')}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(204)
  })
})

describe('GET /api/push/devices', () => {
  it('lists only the caller\'s devices', async () => {
    await post({ token: 'tok-a' })
    await post({ token: 'tok-b' }, otherToken)
    const response = await fetch(`${baseUrl}/api/push/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await response.json() as DeviceListBody
    expect(body.devices).toHaveLength(1)
  })
})
