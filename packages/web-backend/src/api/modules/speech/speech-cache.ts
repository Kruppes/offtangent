/**
 * Disk cache for read-aloud results (W6b): `/api/speech/summary` and
 * `/api/speech/audio` used to build every answer from scratch on every tap.
 *
 * Layout: one file per entry, `<dir>/<sha256-hex>.entry`. The file name is the
 * hash and nothing else, so no part of a request can steer the path (no
 * traversal, no client-chosen names). An entry is
 *
 *   4 bytes  big-endian length N of the meta block
 *   N bytes  UTF-8 JSON meta { v, bytes, sha256, ...caller meta }
 *   rest     the payload (audio bytes, or the JSON of a summary)
 *
 * Writes are atomic: the entry is written to `<hash>.<random>.tmp` in the same
 * directory and renamed into place, so a reader sees the whole entry or none.
 * A read checks the payload length AND its sha256 against the meta; anything
 * that does not match (a torn disk, a foreign file) is deleted and treated as
 * a miss, never served.
 *
 * Size: bounded by `maxBytes` (default 200 MB, `SPEECH_CACHE_MAX_MB` in the
 * environment, 0 switches the cache off). Least recently used entries go
 * first; a hit refreshes the entry's mtime, which is also what the index is
 * rebuilt from after a restart.
 *
 * Concurrency: `inflight()` lets identical concurrent requests share one
 * generation (see the speech service).
 *
 * Authorization is NOT this module's business: the service checks that the
 * caller may read the message BEFORE it computes a key or touches the cache.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SPEECH_CACHE_DEFAULT_MAX_BYTES = 200 * 1024 * 1024
/** Bumped whenever the key material or the entry layout changes. */
export const SPEECH_CACHE_VERSION = 1

const ENTRY_SUFFIX = '.entry'
const HASH_RE = /^[0-9a-f]{64}$/

export interface SpeechCacheEntry<M> {
  meta: M
  payload: Buffer
}

export interface SpeechCache {
  /** Directory the entries live in (for the report and the tests). */
  readonly dir: string
  readonly maxBytes: number
  get<M extends Record<string, unknown>>(key: string): SpeechCacheEntry<M> | null
  put<M extends Record<string, unknown>>(key: string, meta: M, payload: Buffer): boolean
  /** Share one generation between identical concurrent requests. */
  inflight<T>(key: string, produce: () => Promise<T>): Promise<T>
  /** Total payload+meta bytes currently indexed. */
  size(): number
  clear(): void
}

export interface SpeechCacheOptions {
  dir: string
  maxBytes?: number
}

/** `SPEECH_CACHE_MAX_MB` (whole or fractional megabytes); invalid -> default. */
export function speechCacheMaxBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPEECH_CACHE_MAX_MB
  if (raw === undefined || raw.trim() === '') return SPEECH_CACHE_DEFAULT_MAX_BYTES
  const mb = Number(raw)
  if (!Number.isFinite(mb) || mb < 0) return SPEECH_CACHE_DEFAULT_MAX_BYTES
  return Math.floor(mb * 1024 * 1024)
}

/** Stable hash of the key material: sorted-key JSON, sha256, hex. */
export function speechCacheKey(material: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableJson({ v: SPEECH_CACHE_VERSION, ...material })).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
}

/** Normalised source text: line endings, Unicode form and outer whitespace do not make a new clip. */
export function normalizeSpeechText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').normalize('NFC').trim()
}

export function createSpeechDiskCache(options: SpeechCacheOptions): SpeechCache {
  const dir = path.resolve(options.dir)
  const maxBytes = options.maxBytes ?? SPEECH_CACHE_DEFAULT_MAX_BYTES
  /** key -> { bytes, lastUsed } ; Map order is NOT relied upon, lastUsed is. */
  let index: Map<string, { bytes: number; lastUsed: number }> | null = null
  let total = 0
  const pending = new Map<string, Promise<unknown>>()

  function fileOf(key: string): string {
    if (!HASH_RE.test(key)) throw new Error('invalid speech cache key')
    return path.join(dir, key + ENTRY_SUFFIX)
  }

  function load(): Map<string, { bytes: number; lastUsed: number }> {
    if (index) return index
    index = new Map()
    total = 0
    let names: string[] = []
    try {
      fs.mkdirSync(dir, { recursive: true })
      names = fs.readdirSync(dir)
    } catch {
      return index
    }
    for (const name of names) {
      const full = path.join(dir, name)
      if (name.endsWith('.tmp')) {
        // Left over from a write that never finished (crash, kill): never an entry.
        try { fs.rmSync(full, { force: true }) } catch { /* ignore */ }
        continue
      }
      if (!name.endsWith(ENTRY_SUFFIX)) continue
      const key = name.slice(0, -ENTRY_SUFFIX.length)
      if (!HASH_RE.test(key)) continue
      try {
        const st = fs.statSync(full)
        index.set(key, { bytes: st.size, lastUsed: st.mtimeMs })
        total += st.size
      } catch { /* vanished meanwhile */ }
    }
    return index
  }

  function drop(key: string): void {
    const idx = load()
    const known = idx.get(key)
    if (known) { total -= known.bytes; idx.delete(key) }
    try { fs.rmSync(fileOf(key), { force: true }) } catch { /* ignore */ }
  }

  function evict(): void {
    const idx = load()
    if (total <= maxBytes) return
    const byAge = [...idx.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [key] of byAge) {
      if (total <= maxBytes) break
      drop(key)
    }
  }

  return {
    dir,
    maxBytes,

    get<M extends Record<string, unknown>>(key: string): SpeechCacheEntry<M> | null {
      if (maxBytes <= 0) return null
      const idx = load()
      const file = fileOf(key)
      let buf: Buffer
      try {
        buf = fs.readFileSync(file)
      } catch {
        if (idx.has(key)) { total -= idx.get(key)!.bytes; idx.delete(key) }
        return null
      }
      try {
        if (buf.length < 4) throw new Error('short')
        const metaLen = buf.readUInt32BE(0)
        if (metaLen <= 0 || 4 + metaLen > buf.length) throw new Error('meta length')
        const meta = JSON.parse(buf.subarray(4, 4 + metaLen).toString('utf8')) as M & { v?: number; bytes?: number; sha256?: string }
        const payload = buf.subarray(4 + metaLen)
        if (meta.v !== SPEECH_CACHE_VERSION || meta.bytes !== payload.length) throw new Error('payload length')
        if (crypto.createHash('sha256').update(payload).digest('hex') !== meta.sha256) throw new Error('payload hash')
        const now = Date.now()
        const known = idx.get(key)
        if (known) known.lastUsed = now
        else { idx.set(key, { bytes: buf.length, lastUsed: now }); total += buf.length }
        try { fs.utimesSync(file, new Date(now), new Date(now)) } catch { /* best effort */ }
        const { v: _v, bytes: _b, sha256: _s, ...rest } = meta
        return { meta: rest as unknown as M, payload: Buffer.from(payload) }
      } catch {
        // Broken or foreign: never served, and removed so it cannot come back.
        drop(key)
        return null
      }
    },

    put<M extends Record<string, unknown>>(key: string, meta: M, payload: Buffer): boolean {
      if (maxBytes <= 0) return false
      const idx = load()
      const metaBuf = Buffer.from(JSON.stringify({
        ...meta,
        v: SPEECH_CACHE_VERSION,
        bytes: payload.length,
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      }), 'utf8')
      const head = Buffer.alloc(4)
      head.writeUInt32BE(metaBuf.length, 0)
      const size = 4 + metaBuf.length + payload.length
      // One entry larger than the whole budget would evict everything and
      // then itself; it is simply not cached.
      if (size > maxBytes) return false
      const file = fileOf(key)
      const tmp = path.join(dir, `${key}.${crypto.randomBytes(6).toString('hex')}.tmp`)
      try {
        fs.mkdirSync(dir, { recursive: true })
        const fd = fs.openSync(tmp, 'wx', 0o600)
        try {
          fs.writeSync(fd, head)
          fs.writeSync(fd, metaBuf)
          fs.writeSync(fd, payload)
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        fs.renameSync(tmp, file)
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
        console.warn(`[speech-cache] write failed: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
      const known = idx.get(key)
      if (known) total -= known.bytes
      idx.set(key, { bytes: size, lastUsed: Date.now() })
      total += size
      evict()
      return true
    },

    inflight<T>(key: string, produce: () => Promise<T>): Promise<T> {
      const running = pending.get(key) as Promise<T> | undefined
      if (running) return running
      const promise = produce().finally(() => { pending.delete(key) })
      pending.set(key, promise)
      return promise
    },

    size() {
      load()
      return total
    },

    clear() {
      const idx = load()
      for (const key of [...idx.keys()]) drop(key)
      index = null
      total = 0
    },
  }
}
