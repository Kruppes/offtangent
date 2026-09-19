import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createSendFileTool, extractUploadsFromToolResult } from './send-file-tool.js'
import type { SendFileDelivery } from './send-file-tool.js'
import type { UploadDescriptor } from './uploads.js'

function textOf(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function detailsOf(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('send_file_to_user tool', () => {
  let dataDir: string
  let workspaceDir: string
  let originalEnv: { DATA_DIR?: string; WORKSPACE_DIR?: string }

  beforeEach(() => {
    originalEnv = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-send-file-'))
    workspaceDir = path.join(dataDir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true })
    process.env.DATA_DIR = dataDir
    process.env.WORKSPACE_DIR = workspaceDir
  })

  afterEach(() => {
    process.env.DATA_DIR = originalEnv.DATA_DIR
    process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('refuses to run without an active user (background context)', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => undefined })
    fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'hi')

    const result = await tool.execute('call-1', { path: 'a.txt' })

    expect(textOf(result)).toMatch(/background contexts/i)
    expect(detailsOf(result)).toMatchObject({ error: true })
  })

  it('fails cleanly when the file does not exist', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    const result = await tool.execute('call-2', { path: 'missing.txt' })
    expect(textOf(result)).toMatch(/file not found/i)
    expect(detailsOf(result)).toMatchObject({ error: true })
  })

  it('rejects directories', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    const result = await tool.execute('call-3', { path: workspaceDir })
    expect(textOf(result)).toMatch(/not a regular file/i)
    expect(detailsOf(result)).toMatchObject({ error: true })
  })

  it('rejects empty files', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    const filePath = path.join(workspaceDir, 'empty.txt')
    fs.writeFileSync(filePath, '')
    const result = await tool.execute('call-4', { path: filePath })
    expect(textOf(result)).toMatch(/is empty/i)
    expect(detailsOf(result)).toMatchObject({ error: true })
  })

  it('saves an upload and returns an UploadDescriptor in details', async () => {
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 42,
      getCurrentInteractiveSessionId: () => 'session-abc',
      isCarriedByCurrentTurn: () => true,
    })
    fs.writeFileSync(path.join(workspaceDir, 'report.md'), '# Report\n')

    const result = await tool.execute('call-5', { path: 'report.md' })

    const details = detailsOf(result) as { uploadedFile?: UploadDescriptor; error?: boolean }
    expect(details.error).toBeFalsy()
    expect(details.uploadedFile).toBeDefined()
    const upload = details.uploadedFile!
    expect(upload.kind).toBe('file')
    expect(upload.originalName).toBe('report.md')
    expect(upload.mimeType).toMatch(/text\/markdown/)
    expect(upload.urlPath).toMatch(/^\/api\/uploads\//)
    expect(upload.size).toBeGreaterThan(0)

    // Ensure the copied file actually lives in the uploads dir
    const copiedPath = path.join(dataDir, 'uploads', upload.relativePath)
    expect(fs.existsSync(copiedPath)).toBe(true)
    expect(fs.readFileSync(copiedPath, 'utf8')).toBe('# Report\n')
  })

  it('honours the optional filename param as display name', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    fs.writeFileSync(path.join(workspaceDir, 'abc123-tmp.dat'), 'hello')

    const result = await tool.execute('call-6', {
      path: 'abc123-tmp.dat',
      filename: 'Greeting.txt',
    })

    const details = detailsOf(result) as { uploadedFile?: UploadDescriptor }
    expect(details.uploadedFile?.originalName).toBe('Greeting.txt')
    // Mime type is derived from the display name extension, not the stored name
    expect(details.uploadedFile?.mimeType).toMatch(/text\/plain/)
  })

  it('detects image kind from extension', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    const pngPath = path.join(workspaceDir, 'dot.png')
    // Minimal 1x1 PNG
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      // IHDR chunk
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    ])
    fs.writeFileSync(pngPath, pngHeader)

    const result = await tool.execute('call-7', { path: pngPath })
    const details = detailsOf(result) as { uploadedFile?: UploadDescriptor }
    expect(details.uploadedFile?.kind).toBe('image')
    expect(details.uploadedFile?.mimeType).toBe('image/png')
  })

  it('threads caption through to details', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    fs.writeFileSync(path.join(workspaceDir, 'f.txt'), 'x')

    const result = await tool.execute('call-8', {
      path: 'f.txt',
      caption: '  Q3 results  ',
    })
    const details = detailsOf(result) as { caption?: string }
    expect(details.caption).toBe('Q3 results')
  })

  it('carries the caption on the upload descriptor so frame and row metadata keep it', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    fs.writeFileSync(path.join(workspaceDir, 'chart.png'), 'not-really-a-png')

    const result = await tool.execute('call-9', {
      path: 'chart.png',
      caption: '  Probe-Diagramm (400x300 PNG)  ',
    })

    const details = detailsOf(result) as { uploadedFile?: UploadDescriptor }
    expect(details.uploadedFile?.caption).toBe('Probe-Diagramm (400x300 PNG)')
  })

  it('leaves the descriptor without a caption field when none was given', async () => {
    const tool = createSendFileTool({ getCurrentToolUserId: () => 1, isCarriedByCurrentTurn: () => true })
    fs.writeFileSync(path.join(workspaceDir, 'plain.txt'), 'x')

    const result = await tool.execute('call-10', { path: 'plain.txt' })
    const details = detailsOf(result) as { uploadedFile?: UploadDescriptor }
    expect(details.uploadedFile).toBeDefined()
    expect('caption' in details.uploadedFile!).toBe(false)
  })

  it('hands the upload to the delivery sink when one is configured (background task)', async () => {
    const delivered: SendFileDelivery[] = []
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 7,
      getCurrentInteractiveSessionId: () => 'strand-7',
      deliverFile: (delivery) => { delivered.push(delivery); return { messageId: 4711 } },
    })
    fs.writeFileSync(path.join(workspaceDir, 'build.apk'), 'apk-bytes')

    const result = await tool.execute('call-11', { path: 'build.apk', caption: 'Release 0.9.1' })

    expect(detailsOf(result).error).toBeFalsy()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.userId).toBe(7)
    expect(delivered[0]!.sessionId).toBe('strand-7')
    expect(delivered[0]!.caption).toBe('Release 0.9.1')
    expect(delivered[0]!.upload.originalName).toBe('build.apk')
    expect(delivered[0]!.upload.caption).toBe('Release 0.9.1')
  })

  it('refuses to claim delivery when no turn carries the file and no sink exists', async () => {
    // Regression: the tool used to answer "The user sees a download card on
    // this turn" for every stored file, even when nothing was streaming that
    // turn into history — the file stayed in /data/uploads unreferenced.
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 7,
      getCurrentInteractiveSessionId: () => 'strand-7',
      isCarriedByCurrentTurn: () => false,
    })
    fs.writeFileSync(path.join(workspaceDir, 'lost.apk'), 'apk-bytes')

    const result = await tool.execute('call-13', { path: 'lost.apk' })

    expect(detailsOf(result)).toMatchObject({ error: true })
    expect(textOf(result)).toMatch(/NOT delivered/)
    expect(textOf(result)).not.toMatch(/sees a download card/)
  })

  it('treats a sink that persists no message as a failure', async () => {
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 7,
      getCurrentInteractiveSessionId: () => 'strand-7',
      // Zero is what an insert that wrote nothing reports.
      deliverFile: () => ({ messageId: 0 }),
    })
    fs.writeFileSync(path.join(workspaceDir, 'ghost.txt'), 'x')

    const result = await tool.execute('call-14', { path: 'ghost.txt' })

    expect(detailsOf(result)).toMatchObject({ error: true })
    expect(textOf(result)).toMatch(/persisted no chat message/)
  })

  it('names the persisted message id when a sink delivered the file', async () => {
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 7,
      getCurrentInteractiveSessionId: () => 'strand-7',
      deliverFile: () => ({ messageId: 991 }),
    })
    fs.writeFileSync(path.join(workspaceDir, 'ok.txt'), 'x')

    const result = await tool.execute('call-15', { path: 'ok.txt' })

    expect(detailsOf(result).error).toBeFalsy()
    expect(detailsOf(result)).toMatchObject({ messageId: 991 })
    expect(textOf(result)).toMatch(/message #991/)
    expect(textOf(result)).toMatch(/strand-7/)
  })

  it('awaits an async sink before reporting delivery', async () => {
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 7,
      getCurrentInteractiveSessionId: () => 'strand-7',
      deliverFile: async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { messageId: 12 }
      },
    })
    fs.writeFileSync(path.join(workspaceDir, 'async.txt'), 'x')

    const result = await tool.execute('call-16', { path: 'async.txt' })
    expect(textOf(result)).toMatch(/message #12/)
  })

  it('reports a failing delivery sink as a tool error instead of claiming success', async () => {
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 7,
      getCurrentInteractiveSessionId: () => null,
      deliverFile: () => { throw new Error('no strand to deliver to') },
    })
    fs.writeFileSync(path.join(workspaceDir, 'oops.txt'), 'x')

    const result = await tool.execute('call-12', { path: 'oops.txt' })

    expect(textOf(result)).toMatch(/no strand to deliver to/)
    expect(detailsOf(result)).toMatchObject({ error: true })
  })
})

describe('extractUploadsFromToolResult', () => {
  const sample: UploadDescriptor = {
    kind: 'file',
    originalName: 'a.txt',
    storedName: 'xyz-a.txt',
    relativePath: '2025/04/20/xyz-a.txt',
    urlPath: '/api/uploads/2025/04/20/xyz-a.txt',
    mimeType: 'text/plain',
    size: 4,
  }

  it('returns [] for undefined / non-object inputs', () => {
    expect(extractUploadsFromToolResult(undefined)).toEqual([])
    expect(extractUploadsFromToolResult(null)).toEqual([])
    expect(extractUploadsFromToolResult('nope')).toEqual([])
    expect(extractUploadsFromToolResult({})).toEqual([])
    expect(extractUploadsFromToolResult({ details: null })).toEqual([])
  })

  it('extracts uploadedFile', () => {
    const result = extractUploadsFromToolResult({ details: { uploadedFile: sample } })
    expect(result).toEqual([sample])
  })

  it('extracts uploadedFiles array', () => {
    const second = { ...sample, relativePath: 'b', urlPath: '/api/uploads/b', originalName: 'b.txt' }
    const result = extractUploadsFromToolResult({
      details: { uploadedFiles: [sample, second, { not: 'a descriptor' }] },
    })
    expect(result).toHaveLength(2)
    expect(result[0]?.relativePath).toBe(sample.relativePath)
    expect(result[1]?.relativePath).toBe('b')
  })

  it('de-duplicates by relativePath', () => {
    const result = extractUploadsFromToolResult({
      details: { uploadedFile: sample, uploadedFiles: [sample] },
    })
    expect(result).toHaveLength(1)
  })

  it('ignores malformed entries silently', () => {
    const result = extractUploadsFromToolResult({
      details: { uploadedFile: { kind: 'file' /* missing required fields */ } },
    })
    expect(result).toEqual([])
  })
})
