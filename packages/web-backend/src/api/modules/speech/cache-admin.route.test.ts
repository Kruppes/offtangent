/**
 * W7 D2: admin view of the read-aloud disk cache (`GET|DELETE /api/speech/cache`).
 * Synthetic entries only; the cache directory is a temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase } from '@axiom/core'
import { createSpeechRouter } from './route.js'
import { createSpeechDiskCache, speechCacheKey } from './speech-cache.js'
import { generateAccessToken } from '../../../auth.js'

let server: http.Server
let offServer: http.Server
let baseUrl: string
let offUrl: string
let dir: string
let outside: string
const admin = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
const user = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
const cache = () => createSpeechDiskCache({ dir, maxBytes: 1024 * 1024 })
let shared: ReturnType<typeof cache>

async function listen(app: express.Express): Promise<[http.Server, string]> {
  const srv = http.createServer(app)
  await new Promise<void>(resolve => srv.listen(0, resolve))
  return [srv, `http://127.0.0.1:${(srv.address() as { port: number }).port}`]
}

async function call(url: string, method: string, auth: string | null) {
  const res = await fetch(url, { method, headers: auth ? { Authorization: `Bearer ${auth}` } : {} })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-speech-cache-admin-'))
  dir = path.join(root, 'cache', 'speech')
  outside = path.join(root, 'outside.entry')
  fs.writeFileSync(outside, 'must survive')
  shared = cache()
  const db = initDatabase(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/speech', createSpeechRouter({ db, cache: shared }))
  ;[server, baseUrl] = await listen(app)
  const off = express()
  off.use('/api/speech', createSpeechRouter({ db, cache: null }))
  ;[offServer, offUrl] = await listen(off)
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await new Promise<void>(resolve => offServer.close(() => resolve()))
  fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true })
})

describe('GET|DELETE /api/speech/cache', () => {
  it('rejects anonymous (401) and non-admin (403) callers and leaves the cache alone', async () => {
    const key = speechCacheKey({ kind: 'summary', text: 'synthetic auth probe' })
    expect(shared.put(key, { kind: 'summary' }, Buffer.from('{"x":1}'))).toBe(true)
    expect((await call(`${baseUrl}/api/speech/cache`, 'GET', null)).status).toBe(401)
    expect((await call(`${baseUrl}/api/speech/cache`, 'DELETE', null)).status).toBe(401)
    const get = await call(`${baseUrl}/api/speech/cache`, 'GET', user)
    expect(get).toEqual({ status: 403, body: { error: 'forbidden' } })
    const del = await call(`${baseUrl}/api/speech/cache`, 'DELETE', user)
    expect(del).toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(shared.get(key)).not.toBeNull()
  })

  it('reports entries, bytes, hits and misses and empties only its own files', async () => {
    const a = speechCacheKey({ kind: 'summary', text: 'synthetic a' })
    const b = speechCacheKey({ kind: 'audio', text: 'synthetic b' })
    shared.put(a, { kind: 'summary' }, Buffer.from('{"a":1}'))
    shared.put(b, { kind: 'audio' }, Buffer.alloc(64, 1))
    shared.get(a) // hit
    shared.get(speechCacheKey({ kind: 'summary', text: 'never stored' })) // miss
    // A foreign file in the directory and a symlink pointing outside it.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'foreign')
    fs.symlinkSync(outside, path.join(dir, '..%2f..%2foutside.entry'))
    // Even a link under one of our own names only loses the link, never its target.
    fs.symlinkSync(outside, path.join(dir, `${'e'.repeat(64)}.entry`))
    fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.0123456789ab.tmp`), 'torn write')

    const before = await call(`${baseUrl}/api/speech/cache`, 'GET', admin)
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ enabled: true, maxBytes: 1024 * 1024 })
    expect(before.body.entries).toBeGreaterThanOrEqual(2)
    expect(before.body.bytes as number).toBeGreaterThan(64)
    expect(before.body.hits as number).toBeGreaterThanOrEqual(1)
    expect(before.body.misses as number).toBeGreaterThanOrEqual(1)

    const cleared = await call(`${baseUrl}/api/speech/cache`, 'DELETE', admin)
    expect(cleared.status).toBe(200)
    expect(cleared.body.removedEntries).toBe(before.body.entries)
    expect(cleared.body.removedBytes).toBe(before.body.bytes)
    expect(cleared.body).toMatchObject({ enabled: true, entries: 0, bytes: 0 })

    const left = fs.readdirSync(dir).sort()
    expect(left).toEqual(['..%2f..%2foutside.entry', 'notes.txt'])
    expect(fs.readFileSync(outside, 'utf8')).toBe('must survive')
    expect(shared.get(a)).toBeNull()

    const after = await call(`${baseUrl}/api/speech/cache`, 'GET', admin)
    expect(after.body).toMatchObject({ entries: 0, bytes: 0 })
  })

  it('answers calmly when the cache is switched off', async () => {
    const off = await call(`${offUrl}/api/speech/cache`, 'GET', admin)
    expect(off).toEqual({ status: 200, body: { enabled: false, entries: 0, bytes: 0, maxBytes: 0, hits: 0, misses: 0 } })
    const del = await call(`${offUrl}/api/speech/cache`, 'DELETE', admin)
    expect(del.status).toBe(200)
    expect(del.body).toMatchObject({ enabled: false, removedEntries: 0 })
  })
})
