/**
 * `canvas_write`: the door into the canvas of a strand.
 *
 * The cases that matter are the ones where a silent success would be a lie —
 * an invalid key, a document the canvas cannot render, and a context with no
 * writer at all. Each of them must be a visible tool error, because a persona
 * that believes it updated the canvas will tell the user so.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvasWriteTool } from './canvas-write-tool.js'
import { artifactViewEvents } from './artifact-view-events.js'
import type { SendFileDelivery } from './send-file-tool.js'
import type { UploadDescriptor } from './uploads.js'

let tempDir: string
let previousDataDir: string | undefined

function writeDoc(name: string, body = '<!doctype html><h1>Wheel</h1>'): string {
  const file = path.join(tempDir, name)
  fs.writeFileSync(file, body)
  return file
}

interface Captured { upload: UploadDescriptor; caption?: string }

function toolWithSink(captured: Captured[], messageId = 42) {
  return createCanvasWriteTool({
    getCurrentToolUserId: () => 1,
    getCurrentInteractiveSessionId: () => 'strand-1',
    isCarriedByCurrentTurn: () => false,
    deliverFile: (delivery: SendFileDelivery) => {
      captured.push({ upload: delivery.upload, caption: delivery.caption })
      return { messageId }
    },
  })
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-write-'))
  process.env.DATA_DIR = tempDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('canvas_write', () => {
  it('carries key, title and note on the upload descriptor', async () => {
    const captured: Captured[] = []
    const tool = toolWithSink(captured)
    const result = await tool.execute!('call-1', {
      key: 'Front-Wheel',
      title: 'Wheel truing',
      path: writeDoc('view.html'),
      summary: '  measure   spoke 25 first ',
    }) as { details?: Record<string, unknown> }

    expect(captured).toHaveLength(1)
    expect(captured[0]!.upload.viewKey).toBe('front-wheel')
    expect(captured[0]!.upload.viewTitle).toBe('Wheel truing')
    // Whitespace collapsed, so the chat line is one line.
    expect(captured[0]!.upload.viewNote).toBe('measure spoke 25 first')
    expect(result.details?.error).toBeUndefined()
    expect(result.details?.messageId).toBe(42)
  })

  it('refuses a key the view space cannot hold instead of dropping it', async () => {
    const captured: Captured[] = []
    const result = await toolWithSink(captured).execute!('call-2', {
      key: 'front_wheel',
      title: 'Wheel truing',
      path: writeDoc('view.html'),
    }) as { details?: Record<string, unknown>; content: Array<{ text: string }> }

    expect(result.details?.error).toBe(true)
    expect(result.content[0]!.text).toContain('invalid canvas key')
    expect(captured).toHaveLength(0)
  })

  it('refuses a document the canvas cannot render', async () => {
    const captured: Captured[] = []
    const file = path.join(tempDir, 'notes.pdf')
    fs.writeFileSync(file, 'x')
    const result = await toolWithSink(captured).execute!('call-3', {
      key: 'front-wheel',
      title: 'Wheel truing',
      path: file,
    }) as { details?: Record<string, unknown>; content: Array<{ text: string }> }

    expect(result.details?.error).toBe(true)
    expect(result.content[0]!.text).toContain('html, svg and png')
    expect(captured).toHaveLength(0)
  })

  it('reports the missing writer instead of pretending the canvas changed', async () => {
    const tool = createCanvasWriteTool({
      getCurrentToolUserId: () => 1,
      getCurrentInteractiveSessionId: () => null,
      isCarriedByCurrentTurn: () => false,
    })
    const result = await tool.execute!('call-4', {
      key: 'front-wheel',
      title: 'Wheel truing',
      path: writeDoc('view.html'),
    }) as { details?: Record<string, unknown>; content: Array<{ text: string }> }

    expect(result.details?.error).toBe(true)
    expect(result.content[0]!.text).toContain('does not see the new revision')
  })

  it('hands the revision from the store back to the caller', async () => {
    const captured: Captured[] = []
    const tool = createCanvasWriteTool({
      getCurrentToolUserId: () => 1,
      getCurrentInteractiveSessionId: () => 'strand-1',
      isCarriedByCurrentTurn: () => false,
      deliverFile: () => {
        // Stands in for `recordMessageArtifacts()`, which emits exactly this
        // event when it has written the row.
        artifactViewEvents.emitViewUpdate({
          userId: 1,
          strandId: 'strand-1',
          viewKey: 'front-wheel',
          revision: 7,
          latestRevision: 7,
          artifactId: 'art-7',
          title: 'Wheel truing',
          note: null,
          messageId: 99,
          agentId: 'analyst',
          kind: 'html',
        })
        return { messageId: 99 }
      },
    })
    const result = await tool.execute!('call-5', {
      key: 'front-wheel',
      title: 'Wheel truing',
      path: writeDoc('view.html'),
    }) as { details?: Record<string, unknown>; content: Array<{ text: string }> }

    expect(result.details?.revision).toBe(7)
    expect(result.content[0]!.text).toContain('revision 7')
    expect(captured).toHaveLength(0)
  })

  it('leaves the write to the turn when one persists this strand', async () => {
    const deliver = vi.fn()
    const tool = createCanvasWriteTool({
      getCurrentToolUserId: () => 1,
      getCurrentInteractiveSessionId: () => 'strand-1',
      isCarriedByCurrentTurn: () => true,
      deliverFile: deliver,
    })
    const result = await tool.execute!('call-6', {
      key: 'front-wheel',
      title: 'Wheel truing',
      path: writeDoc('view.html'),
    }) as { details?: Record<string, unknown> }

    expect(deliver).not.toHaveBeenCalled()
    const upload = result.details?.uploadedFile as UploadDescriptor
    expect(upload.viewKey).toBe('front-wheel')
    expect(upload.viewTitle).toBe('Wheel truing')
  })
})
