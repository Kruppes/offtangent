/**
 * W6b: disk cache for /api/speech/summary and /api/speech/audio.
 *
 * Proven here, over real HTTP with synthetic messages and fake engines:
 *   - miss then hit (X-Cache), the engine runs once, bytes and headers equal
 *   - the key changes with the voice, the text, the format and the summary model
 *   - LRU bound: the least recently used entry goes first
 *   - authorization before the cache: a foreign caller gets 404 for a cached message
 *   - identical concurrent requests produce exactly one generation
 *   - a streamed clip is cached only when the stream ends; an upstream error
 *     leaves no entry
 *   - broken / torn files are never served, leftover temp files are removed
 *   - file names are hashes only
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import express from 'express'
import { initDatabase } from '@axiom/core'
import type { Database, SpeechSummaryResult } from '@axiom/core'
import { createSpeechRouter } from './route.js'
import { clearSpeechSummaryCache } from './service.js'
import { createSpeechDiskCache, speechCacheKey, speechCacheMaxBytesFromEnv, SPEECH_CACHE_DEFAULT_MAX_BYTES, type SpeechCache } from './speech-cache.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let tmpRoot: string
let cache: SpeechCache

let summarizeCalls = 0
let synthCalls = 0
let cloudCalls = 0
let streamCalls = 0
let voice = 'voice-a'
let summaryModel = 'test-provider:model-a'
let cloudEnabled = false
let streamMode: 'none' | 'ok' | 'error' = 'none'
let synthDelayMs = 0

const FAKE_OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from('synthetic-local-clip')])

function fakeSummary(raw: string): SpeechSummaryResult {
  const text = `Summary of ${raw.length} chars.`
  return { text, language: 'en', sourceChars: raw.length, summaryChars: text.length, model: 'test', passthrough: false } as SpeechSummaryResult
}

function insertMessage(content: string, userId = 1): number {
  const r = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('strand-1', ?, 'assistant', ?, 'main')`,
  ).run(userId, content)
  return Number(r.lastInsertRowid)
}

async function post(route: 'summary' | 'audio', body: unknown, auth: string = token) {
  const res = await fetch(`${baseUrl}/api/speech/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    cache: res.headers.get('x-cache'),
    contentType: res.headers.get('content-type'),
    language: res.headers.get('x-speech-language'),
    summaryChars: res.headers.get('x-speech-summary-chars'),
    expose: res.headers.get('access-control-expose-headers'),
    bytes,
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'speech-cache-test-key'
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-speech-cache-'))
  cache = createSpeechDiskCache({ dir: path.join(tmpRoot, 'cache', 'speech'), maxBytes: 10 * 1024 * 1024 })
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'other', 'x', 'user')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-1', 1, 'main', 'Strand', 'interactive')").run()
  token = generateAccessToken({ userId: 1, username: 'owner', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })

  const app = express()
  app.use(express.json())
  app.use('/api/speech', createSpeechRouter({
    db,
    cache,
    summaryFingerprint: () => summaryModel,
    voiceFingerprint: engine => ({ engine, voice }),
    summarize: async (raw) => { summarizeCalls += 1; return fakeSummary(raw) },
    synthesize: async () => {
      synthCalls += 1
      if (synthDelayMs) await new Promise(r => setTimeout(r, synthDelayMs))
      return FAKE_OGG
    },
    loadTtsConfig: () => ({ baseUrl: 'http://tts.invalid:7400', timeoutMs: 1000 }),
    loadCloudTtsConfig: () => ({ enabled: cloudEnabled }),
    synthesizeCloud: async () => { cloudCalls += 1; return { audio: Buffer.from('OggScloud-synthetic'), contentType: 'audio/ogg' } },
    synthesizeCloudStream: async () => {
      if (streamMode === 'none') return null
      streamCalls += 1
      const mode = streamMode
      async function* chunks() {
        yield Buffer.from('RIFF-part-1|')
        yield Buffer.from('part-2|')
        if (mode === 'error') throw new Error('synthetic upstream break')
        yield Buffer.from('part-3')
      }
      return { stream: Readable.from(chunks()), contentType: 'audio/wav', source: 'primary' as const }
    },
  }))
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  cache.clear()
  clearSpeechSummaryCache()
  summarizeCalls = 0; synthCalls = 0; cloudCalls = 0; streamCalls = 0
  voice = 'voice-a'; summaryModel = 'test-provider:model-a'
  cloudEnabled = false; streamMode = 'none'; synthDelayMs = 0
  db.prepare('DELETE FROM chat_messages').run()
})

describe('speech disk cache over HTTP', () => {
  it('summary: miss then hit, summarizer runs once, same body', async () => {
    const id = insertMessage('Synthetic answer about a test fixture.')
    const first = await post('summary', { messageId: id })
    const second = await post('summary', { messageId: id })
    expect(first.status).toBe(200)
    expect(first.cache).toBe('miss')
    expect(second.cache).toBe('hit')
    expect(second.expose).toContain('X-Cache')
    expect(JSON.parse(second.bytes.toString())).toEqual(JSON.parse(first.bytes.toString()))
    expect(summarizeCalls).toBe(1)
  })

  it('audio: miss then hit, engine runs once, bytes and headers are equal', async () => {
    const id = insertMessage('Synthetic answer number two.')
    const first = await post('audio', { messageId: id })
    const second = await post('audio', { messageId: id })
    expect(first.status).toBe(200)
    expect([first.cache, second.cache]).toEqual(['miss', 'hit'])
    expect(second.bytes.equals(first.bytes)).toBe(true)
    expect(second.bytes.equals(FAKE_OGG)).toBe(true)
    expect(second.contentType).toBe(first.contentType)
    expect(second.language).toBe(first.language)
    expect(second.summaryChars).toBe(first.summaryChars)
    expect(second.expose).toContain('X-Cache')
    expect(synthCalls).toBe(1)
  })

  it('a different voice, text, format or summary model never gets the old clip', async () => {
    const id = insertMessage('Synthetic answer number three.')
    await post('audio', { messageId: id })
    expect(synthCalls).toBe(1)

    voice = 'voice-b'
    expect((await post('audio', { messageId: id })).cache).toBe('miss')
    expect(synthCalls).toBe(2)

    // Edited content of the same message id: new summary input -> new entry.
    db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('Synthetic answer number three, edited and longer.', id)
    expect((await post('audio', { messageId: id })).cache).toBe('miss')
    expect(synthCalls).toBe(3)

    summaryModel = 'test-provider:model-b'
    expect((await post('summary', { messageId: id })).cache).toBe('miss')

    cloudEnabled = true
    expect((await post('audio', { messageId: id, format: 'opus' })).cache).toBe('miss')
    expect((await post('audio', { messageId: id, format: 'wav' })).cache).toBe('miss')
    expect((await post('audio', { messageId: id, format: 'wav' })).cache).toBe('hit')
    expect(cloudCalls).toBe(2)

    const k = (m: Record<string, unknown>) => speechCacheKey(m)
    expect(k({ text: 'a', voice: 1 })).not.toBe(k({ text: 'a', voice: 2 }))
    expect(k({ text: 'a', voice: 1 })).toBe(k({ voice: 1, text: 'a' }))
  })

  it('normalised text: line endings and outer whitespace share one entry', async () => {
    await post('summary', { text: 'Synthetic line one.\r\nline two.' })
    expect((await post('summary', { text: '  Synthetic line one.\nline two.\n' })).cache).toBe('hit')
    expect(summarizeCalls).toBe(1)
  })

  it('checks authorization before the cache: a foreign caller gets 404 for a cached message', async () => {
    const id = insertMessage('Synthetic private answer.')
    expect((await post('audio', { messageId: id })).cache).toBe('miss')
    expect((await post('summary', { messageId: id })).cache).toBe('hit')
    const foreignAudio = await post('audio', { messageId: id }, otherToken)
    const foreignSummary = await post('summary', { messageId: id }, otherToken)
    expect(foreignAudio.status).toBe(404)
    expect(foreignSummary.status).toBe(404)
    expect(foreignAudio.cache).toBeNull()
    expect(foreignAudio.bytes.includes(FAKE_OGG)).toBe(false)
  })

  it('identical concurrent requests produce exactly one generation', async () => {
    const id = insertMessage('Synthetic answer for a race.')
    synthDelayMs = 80
    const results = await Promise.all([1, 2, 3, 4].map(() => post('audio', { messageId: id })))
    expect(results.every(r => r.status === 200 && r.bytes.equals(FAKE_OGG))).toBe(true)
    expect(results.filter(r => r.cache === 'miss')).toHaveLength(1)
    expect(synthCalls).toBe(1)
    expect(summarizeCalls).toBe(1)
  })

  it('caches a streamed clip only when it ends, and serves it buffered afterwards', async () => {
    cloudEnabled = true
    streamMode = 'ok'
    const id = insertMessage('Synthetic streamed answer.')
    const first = await post('audio', { messageId: id, format: 'wav' })
    expect(first.cache).toBe('miss')
    expect(first.bytes.toString()).toBe('RIFF-part-1|part-2|part-3')
    const second = await post('audio', { messageId: id, format: 'wav' })
    expect(second.cache).toBe('hit')
    expect(second.bytes.toString()).toBe('RIFF-part-1|part-2|part-3')
    expect(second.contentType).toBe('audio/wav')
    expect(streamCalls).toBe(1)
  })

  it('never stores a stream that broke upstream', async () => {
    cloudEnabled = true
    streamMode = 'error'
    const id = insertMessage('Synthetic broken stream.')
    await fetch(`${baseUrl}/api/speech/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messageId: id, format: 'wav' }),
    }).then(r => r.arrayBuffer()).catch(() => null)
    await new Promise(r => setTimeout(r, 30))
    streamMode = 'ok'
    const retry = await post('audio', { messageId: id, format: 'wav' })
    expect(retry.cache).toBe('miss')
    expect(retry.bytes.toString()).toBe('RIFF-part-1|part-2|part-3')
    expect(streamCalls).toBe(2)
  })
})

describe('speech disk cache unit', () => {
  const key = (n: number) => speechCacheKey({ n })

  it('evicts the least recently used entry first when over the limit', async () => {
    const dir = path.join(tmpRoot, 'lru')
    const small = createSpeechDiskCache({ dir, maxBytes: 3500 })
    const payload = Buffer.alloc(1000, 1)
    small.put(key(1), { kind: 'x' }, payload)
    await new Promise(r => setTimeout(r, 5))
    small.put(key(2), { kind: 'x' }, payload)
    await new Promise(r => setTimeout(r, 5))
    small.put(key(3), { kind: 'x' }, payload)
    await new Promise(r => setTimeout(r, 5))
    expect(small.get(key(1))).not.toBeNull() // 1 is now the most recent
    await new Promise(r => setTimeout(r, 5))
    small.put(key(4), { kind: 'x' }, payload)
    expect(small.size()).toBeLessThanOrEqual(3500)
    expect(small.get(key(2))).toBeNull()
    expect(small.get(key(1))).not.toBeNull()
    expect(small.get(key(3))).not.toBeNull()
    expect(small.get(key(4))).not.toBeNull()
    // Rebuilt from disk (as after a restart) the bound still holds.
    const reopened = createSpeechDiskCache({ dir, maxBytes: 3500 })
    expect(reopened.size()).toBeLessThanOrEqual(3500)
    expect(reopened.get(key(4))?.payload.equals(payload)).toBe(true)
    // An entry larger than the whole budget is not cached at all.
    expect(small.put(key(5), { kind: 'x' }, Buffer.alloc(5000))).toBe(false)
  })

  it('never serves a torn or tampered file and removes it', () => {
    const dir = path.join(tmpRoot, 'torn')
    const c = createSpeechDiskCache({ dir, maxBytes: 1024 * 1024 })
    c.put(key(1), { kind: 'x' }, Buffer.from('synthetic payload bytes'))
    const file = path.join(dir, `${key(1)}.entry`)
    const full = fs.readFileSync(file)
    fs.writeFileSync(file, full.subarray(0, full.length - 3))
    expect(c.get(key(1))).toBeNull()
    expect(fs.existsSync(file)).toBe(false)

    c.put(key(2), { kind: 'x' }, Buffer.from('synthetic payload bytes'))
    const file2 = path.join(dir, `${key(2)}.entry`)
    const bytes = fs.readFileSync(file2)
    bytes[bytes.length - 1] ^= 0xff
    fs.writeFileSync(file2, bytes)
    expect(c.get(key(2))).toBeNull()
    expect(fs.existsSync(file2)).toBe(false)
  })

  it('removes leftover temp files and only ever writes hash-named entries', () => {
    const dir = path.join(tmpRoot, 'tmpfiles')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${key(9)}.abc.tmp`), 'half')
    const c = createSpeechDiskCache({ dir, maxBytes: 1024 * 1024 })
    c.put(key(1), { kind: 'x' }, Buffer.from('synthetic'))
    const names = fs.readdirSync(dir)
    expect(names).toEqual([`${key(1)}.entry`])
    expect(() => c.get('../../etc/passwd')).toThrow()
    expect(() => c.put('../escape', { kind: 'x' }, Buffer.from('x'))).toThrow()
  })

  it('reads the size limit from SPEECH_CACHE_MAX_MB (default 200 MB, 0 = off)', () => {
    expect(speechCacheMaxBytesFromEnv({})).toBe(SPEECH_CACHE_DEFAULT_MAX_BYTES)
    expect(SPEECH_CACHE_DEFAULT_MAX_BYTES).toBe(200 * 1024 * 1024)
    expect(speechCacheMaxBytesFromEnv({ SPEECH_CACHE_MAX_MB: '50' })).toBe(50 * 1024 * 1024)
    expect(speechCacheMaxBytesFromEnv({ SPEECH_CACHE_MAX_MB: '0' })).toBe(0)
    expect(speechCacheMaxBytesFromEnv({ SPEECH_CACHE_MAX_MB: 'junk' })).toBe(SPEECH_CACHE_DEFAULT_MAX_BYTES)
    const off = createSpeechDiskCache({ dir: path.join(tmpRoot, 'off'), maxBytes: 0 })
    expect(off.put(key(1), { kind: 'x' }, Buffer.from('x'))).toBe(false)
    expect(off.get(key(1))).toBeNull()
  })
})
