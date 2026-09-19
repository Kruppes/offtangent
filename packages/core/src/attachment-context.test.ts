/**
 * Uploads are unrestricted, the model context is not. These tests pin the
 * contract: only formats a model can actually consume are inlined, everything
 * else (video, binary, oversized, SVG) arrives as a reference the agent can
 * open with its file tools.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAttachmentContext } from './attachment-context.js'
import type { UploadDescriptor } from './uploads.js'

let uploadsDir: string

beforeEach(() => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-attctx-'))
})

afterEach(() => {
  fs.rmSync(uploadsDir, { recursive: true, force: true })
})

function write(relativePath: string, content: Buffer | string): number {
  const absolute = path.join(uploadsDir, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return fs.statSync(absolute).size
}

function descriptor(overrides: Partial<UploadDescriptor> & { relativePath: string; mimeType: string; size: number }): UploadDescriptor {
  return {
    kind: overrides.mimeType.startsWith('image/') ? 'image' : 'file',
    originalName: path.basename(overrides.relativePath),
    storedName: path.basename(overrides.relativePath),
    urlPath: `/api/uploads/${overrides.relativePath}`,
    ...overrides,
  } as UploadDescriptor
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff61',
  'hex',
)

describe('buildAttachmentContext', () => {
  it('inlines a small png as image content', () => {
    const size = write('2026/09/14/a-shot.png', PNG)
    const { images, hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/a-shot.png', mimeType: 'image/png', size })],
      { uploadsDir },
    )

    expect(images).toHaveLength(1)
    expect(images[0]!.mimeType).toBe('image/png')
    expect(Buffer.from(images[0]!.data, 'base64').equals(PNG)).toBe(true)
    expect(hints).toHaveLength(0)
  })

  it('references an image that is larger than the inline budget instead of loading it', () => {
    const size = write('2026/09/14/huge.png', PNG)
    const { images, hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/huge.png', mimeType: 'image/png', size: 40 * 1024 * 1024 })],
      { uploadsDir, maxInlineImageBytes: size - 1 },
    )

    expect(images).toHaveLength(0)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('huge.png')
    expect(hints[0]).toContain('too large to inline')
    expect(hints[0]).toContain(path.join(uploadsDir, '2026/09/14/huge.png'))
  })

  it('keeps a video out of the turn and only mentions name, type, size and path', () => {
    const bytes = Buffer.alloc(4096, 7)
    const size = write('2026/09/14/clip.mp4', bytes)
    const { images, hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/clip.mp4', mimeType: 'video/mp4', size })],
      { uploadsDir },
    )

    expect(images).toHaveLength(0)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('clip.mp4')
    expect(hints[0]).toContain('video/mp4')
    expect(hints[0]).toContain('4.0 KB')
    expect(hints[0]).toContain('binary content is not inlined')
    // The raw bytes must not be anywhere in the prompt.
    expect(hints[0]).not.toContain(bytes.toString('binary').slice(0, 32))
  })

  it('treats svg as markup, not as an image the model can see', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
    const size = write('2026/09/14/logo.svg', svg)
    const { images, hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/logo.svg', mimeType: 'image/svg+xml', size })],
      { uploadsDir },
    )

    expect(images).toHaveLength(0)
    expect(hints[0]).toContain('logo.svg')
  })

  it('inlines a small text file', () => {
    const size = write('2026/09/14/notes.md', '# hello\nsome notes')
    const { images, hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/notes.md', mimeType: 'text/markdown', size })],
      { uploadsDir },
    )

    expect(images).toHaveLength(0)
    expect(hints[0]).toContain('some notes')
    expect(hints[0]).not.toContain('truncated')
  })

  it('caps a huge text file and points at the file on disk', () => {
    const body = 'x'.repeat(200 * 1024)
    const size = write('2026/09/14/big.log', body)
    const { hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/big.log', mimeType: 'text/plain', size })],
      { uploadsDir, maxInlineTextBytes: 1024 },
    )

    expect(hints).toHaveLength(1)
    expect(hints[0]!.length).toBeLessThan(4096)
    expect(hints[0]).toContain('truncated')
    expect(hints[0]).toContain(path.join(uploadsDir, '2026/09/14/big.log'))
  })

  it('detects text by extension when the client sent octet-stream', () => {
    const size = write('2026/09/14/data.csv', 'a,b\n1,2')
    const { hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/data.csv', mimeType: 'application/octet-stream', size })],
      { uploadsDir },
    )

    expect(hints[0]).toContain('a,b')
  })

  it('reports a missing file instead of throwing', () => {
    const { images, hints } = buildAttachmentContext(
      [descriptor({ relativePath: '2026/09/14/gone.png', mimeType: 'image/png', size: 10 })],
      { uploadsDir },
    )

    expect(images).toHaveLength(0)
    expect(hints[0]).toContain('Image upload failed to read')
  })

  it('returns nothing for no attachments', () => {
    expect(buildAttachmentContext(undefined, { uploadsDir })).toEqual({ images: [], hints: [] })
    expect(buildAttachmentContext([], { uploadsDir })).toEqual({ images: [], hints: [] })
  })
})
