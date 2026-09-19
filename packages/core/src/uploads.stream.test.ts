/**
 * `saveUploadFromFile` is the disk path of the upload pipeline: multer has
 * already streamed the body into `<uploads>/.tmp`, and the file is moved into
 * place without ever becoming a Buffer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  saveUploadFromFile,
  ensureUploadsTempDir,
  getUploadsTempDir,
  getUploadsDir,
  cleanupStaleTempUploads,
  getFreeDiskBytes,
} from './uploads.js'

let tmpDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-upload-stream-'))
  process.env.DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

function stagePart(content: Buffer | string): string {
  const dir = ensureUploadsTempDir()
  const partPath = path.join(dir, `part-${Math.random().toString(36).slice(2)}.part`)
  fs.writeFileSync(partPath, content)
  return partPath
}

describe('saveUploadFromFile', () => {
  it('moves the staged file into the uploads tree and reports its size', () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 9)
    const partPath = stagePart(payload)

    const descriptor = saveUploadFromFile({
      sourcePath: partPath,
      originalName: 'holiday.mp4',
      mimeType: 'video/mp4',
      source: 'web',
    })

    expect(fs.existsSync(partPath)).toBe(false)
    const absolute = path.join(getUploadsDir(), descriptor.relativePath)
    expect(fs.statSync(absolute).size).toBe(payload.length)
    expect(descriptor.size).toBe(payload.length)
    expect(descriptor.kind).toBe('file')
    expect(descriptor.mimeType).toBe('video/mp4')
    expect(descriptor.originalName).toBe('holiday.mp4')
    expect(descriptor.storedName).toMatch(/^[0-9a-f]{24}-holiday\.mp4$/)
    expect(fs.readdirSync(getUploadsTempDir())).toHaveLength(0)
  })

  it('stores under a generated name and neutralizes a traversal file name', () => {
    const descriptor = saveUploadFromFile({
      sourcePath: stagePart('x'),
      originalName: '../../../etc/passwd',
      mimeType: 'application/octet-stream',
      source: 'web',
    })

    expect(descriptor.storedName).not.toContain('/')
    expect(descriptor.storedName).not.toContain('..')
    const uploadsRoot = path.resolve(getUploadsDir())
    const absolute = path.resolve(uploadsRoot, descriptor.relativePath)
    expect(absolute.startsWith(uploadsRoot + path.sep)).toBe(true)
    expect(fs.existsSync(absolute)).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'etc', 'passwd'))).toBe(false)
  })

  it('strips control characters and newlines from the name', () => {
    const descriptor = saveUploadFromFile({
      sourcePath: stagePart('x'),
      originalName: 'we\u0000ird\r\nname\u202E.txt',
      mimeType: 'text/plain',
      source: 'web',
    })

    // eslint-disable-next-line no-control-regex
    expect(descriptor.storedName).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/)
    // eslint-disable-next-line no-control-regex
    expect(descriptor.originalName).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/)
    expect(descriptor.storedName.endsWith('.txt')).toBe(true)
  })

  it('defaults an unknown type to octet-stream instead of refusing it', () => {
    const descriptor = saveUploadFromFile({
      sourcePath: stagePart('MZ binary'),
      originalName: 'tool.exe',
      mimeType: '',
      source: 'web',
    })

    expect(descriptor.mimeType).toBe('application/octet-stream')
    expect(descriptor.kind).toBe('file')
  })

  it('measures a png from its header without reading the whole file', () => {
    const header = Buffer.from('89504e470d0a1a0a0000000d4948445200000280000001e00806000000', 'hex')
    const png = Buffer.concat([header, Buffer.alloc(512 * 1024, 0)])

    const descriptor = saveUploadFromFile({
      sourcePath: stagePart(png),
      originalName: 'wide.png',
      mimeType: 'image/png',
      source: 'web',
    })

    expect(descriptor.kind).toBe('image')
    expect(descriptor.width).toBe(640)
    expect(descriptor.height).toBe(480)
    expect(descriptor.previewUrl).toContain('preview=1')
  })
})

describe('temp dir housekeeping', () => {
  it('removes abandoned part files older than a day and keeps fresh ones', () => {
    const stale = stagePart('interrupted')
    const fresh = stagePart('in flight')
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    fs.utimesSync(stale, old, old)

    const removed = cleanupStaleTempUploads(new Date())

    expect(removed).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('reports free disk space for the uploads volume', () => {
    const free = getFreeDiskBytes()
    expect(free === null || free > 0).toBe(true)
  })
})
