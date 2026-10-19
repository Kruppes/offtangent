/**
 * Review 2026-10-19, findings 6 and 7, and re-review N4/N5/N6: junk handles
 * are removed only by an explicit slug list, only for automatic sources that
 * were never stored explicitly, after a complete and verified exclusive 0600
 * backup, and only while the backend is stopped (no file lock). secrets.json
 * is written atomically with 0600. Synthetic values only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanupSecretHandlesBySlug, findRunningBackend, parseSlugList, runCleanupCli, writeExclusiveBackup } from './secret-handle-cleanup.js'
import { invalidateSecretHandleCache, listSecrets, sealSecret } from './secret-store.js'
import { saveSecrets, loadSecrets, secretsFilePath } from './secrets-config.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

const mode = (file: string): number => fs.statSync(file).mode & 0o777

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cleanup-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-cleanup'
  invalidateSecretHandleCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
})

describe('cleanupSecretHandlesBySlug', () => {
  it('never removes form handles, even a dictionary word or a repeated PIN (finding 6)', () => {
    const formWord = sealSecret(['pass', 'word'].join(''), 'password', 'form')
    const formPin = sealSecret('11111111', 'pin', 'form')
    const chat = sealSecret('changeme', 'password', 'chat')
    const junk = sealSecret('complete', 'url-password', 'tool:shell')

    const dry = cleanupSecretHandlesBySlug({ slugs: [formWord, formPin, chat, junk], apply: false })
    expect(dry.refused).toBe(true)
    expect(dry.handles.map(h => h.status)).toEqual(['source-not-allowed', 'source-not-allowed', 'source-not-allowed', 'remove'])

    // all-or-nothing: a refused slug in the list blocks the whole run
    const applied = cleanupSecretHandlesBySlug({ slugs: [formWord, junk], apply: true, backupSuffix: 't1' })
    expect(applied.applied).toBe(false)
    expect(listSecrets().map(s => s.slug).sort()).toEqual([formWord, formPin, chat, junk].sort())
    expect(fs.existsSync(`${secretsFilePath()}.bak-t1`)).toBe(false)
  })

  it('nothing is selected by value: without a slug list nothing is removed', () => {
    sealSecret('complete', 'url-password', 'tool:shell')
    const r = cleanupSecretHandlesBySlug({ slugs: [], apply: true, backupSuffix: 't2' })
    expect(r.applied).toBe(false)
    expect(listSecrets()).toHaveLength(1)
  })

  it('refuses unknown slugs', () => {
    const junk = sealSecret('complete', 'url-password', 'tool:shell')
    const r = cleanupSecretHandlesBySlug({ slugs: [junk, 'does-not-exist-1'], apply: true, backupSuffix: 't3' })
    expect(r.refused).toBe(true)
    expect(r.handles[1]!.status).toBe('unknown-slug')
    expect(listSecrets()).toHaveLength(1)
  })

  it('removes named tool:shell / vaultwarden handles, keeps the rest, writes an exclusive 0600 backup (finding 7)', () => {
    const keep = sealSecret(['Hx4', 'q9Lm', '2Wv'].join(''), 'password', 'form')
    const junkA = sealSecret('complete', 'url-password', 'tool:shell')
    const junkB = sealSecret('Vault is locked.', 'vaultwarden', 'vaultwarden')
    fs.chmodSync(secretsFilePath(), 0o644) // a loose file from an old version

    const before = fs.readFileSync(secretsFilePath())
    const r = cleanupSecretHandlesBySlug({ slugs: [junkA, junkB], apply: true, backupSuffix: 't4' })
    expect(r).toMatchObject({ applied: true, refused: false, removed: 2 })
    expect(listSecrets().map(s => s.slug)).toEqual([keep])

    const backup = `${secretsFilePath()}.bak-t4`
    expect(r.backupPath).toBe(backup)
    expect(fs.readFileSync(backup).equals(before)).toBe(true)
    expect(mode(backup)).toBe(0o600)
    expect(mode(secretsFilePath())).toBe(0o600)
    // the report never carries a value
    expect(JSON.stringify(r).includes('complete')).toBe(false)
    expect(JSON.stringify(r).includes('Vault is locked')).toBe(false)

    // the backup is exclusive: an existing file is never overwritten
    const again = sealSecret('session', 'url-password', 'tool:shell')
    expect(() => cleanupSecretHandlesBySlug({ slugs: [again], apply: true, backupSuffix: 't4' })).toThrow()
    expect(fs.readFileSync(backup).equals(before)).toBe(true)
    expect(listSecrets().some(s => s.slug === again)).toBe(true)
  })

  it('re-checks the origin on apply: a handle whose source changed to form is refused', () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    // simulate a concurrent change of origin between dry run and apply
    expect(cleanupSecretHandlesBySlug({ slugs: [slug], apply: false }).refused).toBe(false)
    const file = loadSecrets()
    file.handles![slug]!.source = 'form'
    saveSecrets(file)
    invalidateSecretHandleCache()
    const r = cleanupSecretHandlesBySlug({ slugs: [slug], apply: true, backupSuffix: 't5' })
    expect(r.applied).toBe(false)
    expect(listSecrets()).toHaveLength(1)
  })

  it('a value first sealed from tool output and then stored via the form is never cleaned up (re-review N4)', () => {
    const pw = ['Hx4', 'q9Lm', '2Wv'].join('')
    const slug = sealSecret(pw, 'url-password', 'tool:shell')
    expect(sealSecret(pw, 'password', 'form')).toBe(slug)
    expect(listSecrets().find(s => s.slug === slug)?.source).toBe('form')
    // a later automatic hit never downgrades the origin again
    expect(sealSecret(pw, 'url-password', 'tool:shell')).toBe(slug)
    expect(listSecrets().find(s => s.slug === slug)?.source).toBe('form')
    expect(loadSecrets().handles![slug]!.explicitlyStored).toBe(true)

    const r = cleanupSecretHandlesBySlug({ slugs: [slug], apply: true, backupSuffix: 'n4' })
    expect(r).toMatchObject({ applied: false, refused: true })
    expect(listSecrets().map(s => s.slug)).toEqual([slug])
  })

  it('a backup that cannot be verified completely aborts the cleanup without removing anything (re-review N6)', () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    const before = fs.readFileSync(secretsFilePath())
    const realWrite = fs.writeSync.bind(fs) as (fd: number, buf: Buffer, off: number, len: number) => number
    // a write that claims to be complete but stores only the first bytes
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Buffer, off?: number, len?: number) => {
      const o = off ?? 0
      const l = len ?? buf.length - o
      realWrite(fd, buf, o, Math.min(l, 16))
      return l
    }) as typeof fs.writeSync)
    expect(() => cleanupSecretHandlesBySlug({ slugs: [slug], apply: true, backupSuffix: 'n6a' })).toThrow(/does not match/)
    vi.restoreAllMocks()
    expect(fs.readFileSync(secretsFilePath()).equals(before)).toBe(true)
    invalidateSecretHandleCache()
    expect(listSecrets().map(s => s.slug)).toEqual([slug])
  })

  it('short writes are continued until the backup is complete (re-review N6)', () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    const keep = sealSecret(['Hx4', 'q9Lm', '2Wv'].join(''), 'password', 'form')
    const before = fs.readFileSync(secretsFilePath())
    const realWrite = fs.writeSync.bind(fs) as (fd: number, buf: Buffer, off: number, len: number) => number
    // honest short writes: at most 7 bytes per call, the real count is returned
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Buffer, off?: number, len?: number) => {
      const o = off ?? 0
      const l = len ?? buf.length - o
      return realWrite(fd, buf, o, Math.min(l, 7))
    }) as typeof fs.writeSync)
    const r = cleanupSecretHandlesBySlug({ slugs: [slug], apply: true, backupSuffix: 'n6b' })
    vi.restoreAllMocks()
    expect(r).toMatchObject({ applied: true, removed: 1 })
    expect(fs.readFileSync(r.backupPath!).equals(before)).toBe(true)
    invalidateSecretHandleCache()
    expect(listSecrets().map(s => s.slug)).toEqual([keep])
  })
})

describe('saveSecrets (re-review N5)', () => {
  it('never writes the content into a file with looser bits, replaces atomically, and does not swallow a chmod error', () => {
    const file = secretsFilePath()
    saveSecrets({ env: {} })
    fs.chmodSync(file, 0o644) // a loose file from an old version
    const inodeBefore = fs.statSync(file).ino

    const modesAtWrite: number[] = []
    const realWrite = fs.writeSync.bind(fs) as (fd: number, buf: Buffer, off: number, len: number) => number
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Buffer, off?: number, len?: number) => {
      modesAtWrite.push(fs.fstatSync(fd).mode & 0o777)
      const o = off ?? 0
      return realWrite(fd, buf, o, len ?? buf.length - o)
    }) as typeof fs.writeSync)
    const realWriteFile = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      modesAtWrite.push(typeof target === 'number' ? fs.fstatSync(target).mode & 0o777 : fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : -1)
      realWriteFile(target, data, options)
    }) as typeof fs.writeFileSync)
    saveSecrets({ env: { A: 'x' } })
    vi.restoreAllMocks()

    expect(modesAtWrite.length).toBeGreaterThan(0)
    expect(modesAtWrite.every(m => m === 0o600)).toBe(true)
    expect(mode(file)).toBe(0o600)
    expect(fs.statSync(file).ino).not.toBe(inodeBefore) // replaced by rename, not rewritten in place
    expect(loadSecrets().env).toEqual({ A: 'x' })

    // a failing permission change is an error and leaves the old file intact
    const failing = new Error('EPERM: simulated')
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => { throw failing })
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw failing })
    expect(() => saveSecrets({ env: { B: 'y' } })).toThrow(/EPERM/)
    vi.restoreAllMocks()
    expect(loadSecrets().env).toEqual({ A: 'x' })
    expect(fs.readdirSync(path.dirname(file)).filter(f => f.includes('.tmp-'))).toEqual([])
  })
})

describe('cleanup CLI refuses while the backend runs (no file lock)', () => {
  function fakeProc(cmdlines: Record<string, string[]>): string {
    const dir = path.join(tmpDir, 'proc')
    for (const [pid, argv] of Object.entries(cmdlines)) {
      fs.mkdirSync(path.join(dir, pid), { recursive: true })
      fs.writeFileSync(path.join(dir, pid, 'cmdline'), argv.join('\0') + '\0')
    }
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  async function closedPort(): Promise<number> {
    const server = net.createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>(resolve => server.close(() => resolve()))
    return port
  }

  it('aborts without any change when a `node dist/server.js` process is found', async () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    const before = fs.readFileSync(secretsFilePath())
    const procDir = fakeProc({ '4242': ['node', 'dist/server.js'], '17': ['bash'] })
    for (const args of [['--slugs', slug, '--apply'], ['--slugs', slug]]) {
      const r = await runCleanupCli(args, { procDir, port: await closedPort(), selfPid: 1 })
      expect(r.code).toBe(3)
      expect(r.err.join('\n')).toMatch(/backend is running/)
      expect(r.err.join('\n')).toMatch(/process 4242/)
    }
    expect(fs.readFileSync(secretsFilePath()).equals(before)).toBe(true)
    expect(fs.readdirSync(path.join(tmpDir, 'config')).filter(f => f.includes('.bak-'))).toEqual([])
  })

  it('aborts without any change when the health port accepts connections', async () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    const before = fs.readFileSync(secretsFilePath())
    const server = net.createServer(socket => socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const r = await runCleanupCli(['--slugs', slug, '--apply'], { procDir: fakeProc({}), port, selfPid: 1 })
      expect(r.code).toBe(3)
      expect(r.err.join('\n')).toMatch(/accepts connections/)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    expect(fs.readFileSync(secretsFilePath()).equals(before)).toBe(true)
    expect(listSecrets().map(s => s.slug)).toEqual([slug])
  })

  it('runs (dry run, then --apply) when no backend is found; values are never printed', async () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    const probe = { procDir: fakeProc({ '17': ['bash'] }), port: await closedPort(), selfPid: 1 }
    expect(await findRunningBackend(probe)).toEqual([])
    const dry = await runCleanupCli(['--slugs', slug], probe)
    expect(dry.code).toBe(0)
    expect(listSecrets()).toHaveLength(1)
    const applied = await runCleanupCli([`--slugs=${slug}`, '--apply'], probe)
    expect(applied.code).toBe(0)
    expect(listSecrets()).toHaveLength(0)
    expect([...dry.out, ...dry.err, ...applied.out, ...applied.err].join('\n').includes('complete')).toBe(false)
  })
})

describe('helpers', () => {
  it('parseSlugList trims and dedupes', () => {
    expect(parseSlugList(' a,b , a,,c ')).toEqual(['a', 'b', 'c'])
  })

  it('writeExclusiveBackup creates 0600 and refuses to overwrite', () => {
    const file = path.join(tmpDir, 'b.bak')
    writeExclusiveBackup(file, Buffer.from('x'))
    expect(mode(file)).toBe(0o600)
    expect(() => writeExclusiveBackup(file, Buffer.from('y'))).toThrow()
    expect(fs.readFileSync(file, 'utf-8')).toBe('x')
  })

  it('saveSecrets leaves secrets.json at 0600 even when it existed with looser bits', () => {
    saveSecrets({ env: {} })
    fs.chmodSync(secretsFilePath(), 0o644)
    saveSecrets({ env: {} })
    expect(mode(secretsFilePath())).toBe(0o600)
  })
})
