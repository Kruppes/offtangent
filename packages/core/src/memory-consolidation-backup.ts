import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDataDir } from './uploads.js'

export interface ConsolidationBackupResult {
  relativeDir: string
  files: number
  bytes: number
  pruned: number
  cleanupError?: string
  reused?: boolean
  empty?: boolean
}

export type ConsolidationBackupErrorCode = 'symlink' | 'network_volume' | 'other_volume' | 'outside_data' | 'no_space' | 'permission' | 'source_changed' | 'retention_invalid' | 'unknown'

export class ConsolidationBackupError extends Error {
  constructor(readonly code: ConsolidationBackupErrorCode) {
    super(`Memory backup failed (${code})`)
    this.name = 'ConsolidationBackupError'
  }
}

export function consolidationBackupScopeId(memoryDir: string, dataDir = getDataDir()): string {
  return createHash('sha256').update(path.relative(path.resolve(dataDir), path.resolve(memoryDir))).digest('hex').slice(0, 8)
}

function classifyBackupError(error: unknown): ConsolidationBackupError {
  if (error instanceof ConsolidationBackupError) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return new ConsolidationBackupError('no_space')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new ConsolidationBackupError('permission')
  if (code === 'ELOOP') return new ConsolidationBackupError('symlink')
  const message = error instanceof Error ? error.message : ''
  if (message.includes('symlink')) return new ConsolidationBackupError('symlink')
  if (message.includes('Network backup volume')) return new ConsolidationBackupError('network_volume')
  if (message.includes('another volume')) return new ConsolidationBackupError('other_volume')
  if (message.includes('outside data')) return new ConsolidationBackupError('outside_data')
  if (message.includes('source changed')) return new ConsolidationBackupError('source_changed')
  if (message.includes('retention')) return new ConsolidationBackupError('retention_invalid')
  return new ConsolidationBackupError('unknown')
}

// Compare file lists and bytes, never directory mtimes or source file names in diagnostics.
function fingerprint(directory: string, data: string): string {
  const hash = createHash('sha256')
  const visit = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = checkedPath(data, path.join(dir, entry.name))
      const relative = prefix + entry.name
      if (entry.isDirectory()) visit(file, relative + '/')
      else if (entry.isFile()) {
        hash.update(relative).update('\0').update(createHash('sha256').update(fs.readFileSync(file)).digest()).update('\0')
      } else throw new ConsolidationBackupError('symlink')
    }
  }
  visit(directory, '')
  return hash.digest('hex')
}

const COMPLETE = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z(?:-\d+)?$/

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function checkedPath(data: string, value: string): string {
  const target = path.resolve(value)
  if (!inside(data, target)) throw new Error('Backup path outside data directory')
  let current = path.parse(target).root
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Backup symlink rejected')
      if (!inside(data, fs.realpathSync(current)) && inside(data, current)) throw new Error('Backup path outside data directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return target
}

function copyAllowed(source: string, target: string, data: string, stats: { files: number; bytes: number }): void {
  checkedPath(data, source)
  const info = fs.lstatSync(source)
  if (info.isSymbolicLink()) throw new Error('Backup symlink rejected')
  if (info.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o700 })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const child = path.join(source, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Backup symlink rejected')
      if (entry.isDirectory()) copyAllowed(child, path.join(target, entry.name), data, stats)
      else if (entry.name.endsWith('.md')) copyAllowed(child, path.join(target, entry.name), data, stats)
    }
    fs.chmodSync(target, info.mode & 0o700)
  } else if (info.isFile()) {
    const reader = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const opened = fs.fstatSync(reader)
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Backup source changed')
      const writer = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, info.mode & 0o600)
      try {
        const block = Buffer.allocUnsafe(64 * 1024)
        let size = 0
        for (;;) {
          const read = fs.readSync(reader, block, 0, block.length, null)
          if (!read) break
          let written = 0
          while (written < read) written += fs.writeSync(writer, block, written, read - written)
          size += read
        }
        fs.fchmodSync(writer, info.mode & 0o600)
        fs.fsyncSync(writer)
        stats.files++
        stats.bytes += size
      } finally { fs.closeSync(writer) }
    } finally { fs.closeSync(reader) }
  } else {
    throw new Error('Unsupported backup source type')
  }
}

/** A complete backup is published before the consolidation task gets any write capability. */
export function createConsolidationBackup(memoryDir: string, retention = 7, dataDir = getDataDir()): ConsolidationBackupResult {
  try {
    return createBackup(memoryDir, retention, dataDir)
  } catch (error) {
    throw classifyBackupError(error)
  }
}

function createBackup(memoryDir: string, retention: number, dataDir: string): ConsolidationBackupResult {
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw new Error('Invalid backup retention (1-365)')
  const originalData = path.resolve(dataDir)
  const data = fs.realpathSync(originalData)
  const requestedSource = path.resolve(memoryDir)
  if (!inside(originalData, requestedSource)) throw new Error('Backup path outside data directory')
  const source = checkedPath(data, path.join(data, path.relative(originalData, requestedSource)))
  const relative = path.relative(data, source)
  if (!relative || relative.startsWith('memory-consolidation-backups' + path.sep)) throw new Error('Invalid backup source')
  const base = checkedPath(data, path.join(data, 'memory-consolidation-backups'))
  const scope = checkedPath(data, path.join(base, createHash('sha256').update(relative).digest('hex')))
  if (inside(source, scope) || inside(scope, source)) throw new Error('Overlapping backup paths')
  const root = fs.statSync(source)
  if (!root.isDirectory()) throw new Error('Backup source is not a directory')
  const dataStats = fs.statSync(data)
  if (root.dev !== dataStats.dev) throw new Error('Backup source is on another volume')
  // Reject known Linux network filesystem types and FUSE (including SSHFS).
  // Unknown types are not classified as local; deployment must verify the data volume.
  const fsType = Number(fs.statfsSync(data).type)
  const networkTypes = [
    0x6969, // NFS
    0xff534d42, 0xfe534d42, 0x517b, // CIFS, SMB2, old SMB
    0x01021997, // 9p
    0x00c36400, // Ceph
    0x5346414f, 0x6b414653, // AFS
    0x564c, // NCP
    0x65735546, // FUSE (also rejects local FUSE volumes)
  ]
  if (networkTypes.includes(fsType)) throw new Error('Network backup volume rejected')
  fs.mkdirSync(base, { mode: 0o700, recursive: true })
  fs.mkdirSync(scope, { mode: 0o700, recursive: true })
  checkedPath(data, scope)
  if (fs.statSync(scope).dev !== root.dev) throw new Error('Backup target is on another volume')
  const stamp = new Date().toISOString().replace(/:/g, '-')
  let name = stamp
  for (let index = 1; fs.existsSync(path.join(scope, name)) || fs.existsSync(path.join(scope, `${name}.partial`)); index++) name = `${stamp}-${String(index).padStart(6, '0')}`
  const partial = checkedPath(data, path.join(scope, `${name}.partial`))
  const final = checkedPath(data, path.join(scope, name))
  fs.mkdirSync(partial, { mode: 0o700 })
  const stats = { files: 0, bytes: 0 }
  let reused: string | undefined
  let empty = false
  try {
    for (const entry of ['MEMORY.md', 'wiki', 'users']) {
      const file = checkedPath(data, path.join(source, entry))
      try { fs.lstatSync(file) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      copyAllowed(file, path.join(partial, entry), data, stats)
    }
    const complete = fs.readdirSync(scope, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && COMPLETE.test(entry.name)).map(entry => entry.name).sort()
    const latest = complete.at(-1)
    empty = stats.files === 0
    reused = !empty && latest && fingerprint(partial, data) === fingerprint(checkedPath(data, path.join(scope, latest)), data) ? latest : undefined
    if (empty || reused) fs.rmSync(partial, { recursive: true, force: true })
    else {
      fs.renameSync(partial, final)
      const fd = fs.openSync(scope, fs.constants.O_RDONLY)
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    }
  } catch (error) {
    try { fs.rmSync(partial, { recursive: true, force: true }) } catch { /* preserve original failure */ }
    throw error
  }
  let pruned = 0
  let cleanupError: string | undefined
  try {
    const entries = fs.readdirSync(scope, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.endsWith('.partial')) fs.rmSync(checkedPath(data, path.join(scope, entry.name)), { recursive: true, force: true })
    }
    const complete = entries.filter(entry => entry.isDirectory() && COMPLETE.test(entry.name)).map(entry => entry.name).sort()
    for (const expired of complete.filter(name => name !== path.basename(final)).slice(0, Math.max(0, complete.length - retention))) {
      fs.rmSync(checkedPath(data, path.join(scope, expired)), { recursive: true, force: true })
      pruned++
    }
  } catch {
    cleanupError = 'Backup cleanup failed'
  }
  return { relativeDir: empty ? '' : path.relative(data, reused ? path.join(scope, reused) : final), ...stats, pruned,
    ...(empty ? { empty: true } : {}), ...(reused ? { reused: true } : {}), ...(cleanupError ? { cleanupError } : {}) }
}
