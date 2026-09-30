/**
 * The artifact gap of the two non-TurnRunner delivery paths.
 *
 * `TurnRunner.finalize()` calls `recordArtifacts()` for every assistant row it
 * writes, so an html/svg file sent during an interactive turn becomes a canvas
 * artifact. The two other writers of assistant rows did not:
 *
 *   - `deliverTaskFile()` (a background task calling `send_file_to_user`)
 *   - `TaskInjectionTranscript.persist()` (the persona reacting to a finished
 *     task and sending a file inside that reaction)
 *
 * Measured on the live database before this test existed: `chat_messages`
 * 135305 and 135482 both carry an `.html` file in `metadata.files` and have no
 * row in `artifacts`, so the user got a download card instead of a canvas.
 *
 * These tests pin the fix: the same extraction, on the same strand, from both
 * paths.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase, listArtifactsForMessages, listStrandViews, saveUpload } from '@axiom/core'
import type { Database, UploadDescriptor } from '@axiom/core'
import { deliverTaskFile } from './task-file-delivery.js'
import { TaskInjectionTranscript } from './task-injection-response.js'

const USER_ID = 7
const SESSION_ID = 'strand-that-ordered-the-view'
const HTML = '<!doctype html><html><head><title>Front wheel</title></head><body><p>round 1</p></body></html>'

let tempDir: string
let previousDataDir: string | undefined
let db: Database

function storeHtmlUpload(name = 'front-wheel.html'): UploadDescriptor {
  return saveUpload({
    buffer: Buffer.from(HTML, 'utf8'),
    originalName: name,
    mimeType: 'text/html; charset=utf-8',
    source: 'web',
    userId: USER_ID,
    sessionId: SESSION_ID,
  })
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-artifact-gap-'))
  previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = tempDir
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'x', 'admin')").run(USER_ID)
})

afterEach(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('artifacts from a background task delivery', () => {
  it('records the html file as a canvas artifact of the triggering strand', () => {
    const upload = storeHtmlUpload()

    const result = deliverTaskFile({ db, chatEventBus: null }, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      agentId: 'coder',
      upload,
    })

    const byMessage = listArtifactsForMessages(db, USER_ID, [result.messageId])
    const artifacts = byMessage.get(result.messageId) ?? []
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'html',
      source: 'upload',
      strandId: SESSION_ID,
      messageId: result.messageId,
      agentId: 'coder',
      userId: USER_ID,
    })
    expect(result.artifactIds).toEqual([artifacts[0]!.id])
  })

  it('leaves a non-renderable file without an artifact', () => {
    const upload = saveUpload({
      buffer: Buffer.alloc(1024, 3),
      originalName: 'report.zip',
      mimeType: 'application/zip',
      source: 'web',
      userId: USER_ID,
      sessionId: SESSION_ID,
    })

    const result = deliverTaskFile({ db, chatEventBus: null }, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      agentId: 'coder',
      upload,
    })

    expect(listArtifactsForMessages(db, USER_ID, [result.messageId]).get(result.messageId)).toBeUndefined()
    expect(result.artifactIds).toEqual([])
  })
})

describe('a background task updating a living view', () => {
  it('turns two deliveries of the same view key into revision 1 and 2 of one view', () => {
    const first = storeHtmlUpload('front-wheel-1.html')
    first.viewKey = 'front-wheel'
    const second = storeHtmlUpload('front-wheel-2.html')
    second.viewKey = 'front-wheel'

    const a = deliverTaskFile({ db, chatEventBus: null }, {
      userId: USER_ID, sessionId: SESSION_ID, agentId: 'coder', upload: first,
    })
    const b = deliverTaskFile({ db, chatEventBus: null }, {
      userId: USER_ID, sessionId: SESSION_ID, agentId: 'coder', upload: second,
    })

    const views = listStrandViews(db, USER_ID, SESSION_ID)
    expect(views).toHaveLength(1)
    expect(views[0]!.viewKey).toBe('front-wheel')
    expect(views[0]!.latestRevision).toBe(2)
    expect(views[0]!.revisions.map(r => r.messageId)).toEqual([a.messageId, b.messageId])
    // Two messages, two cards in history - the view is what collapses them,
    // not a rewritten row.
    expect(a.messageId).not.toBe(b.messageId)
    expect(a.artifactIds).toHaveLength(1)
    expect(b.artifactIds).toHaveLength(1)
  })
})

describe('artifacts from a task-injection reaction', () => {
  it('records the html file the injection sent as a canvas artifact', () => {
    const upload = storeHtmlUpload('wheel-round-2.html')
    const transcript = new TaskInjectionTranscript()
    transcript.record({ type: 'text', text: 'Here is round 2.' })
    transcript.record({
      type: 'tool_call_end',
      toolResult: { details: { uploadedFile: upload } },
    })

    const messageId = transcript.persist(db, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      agentId: 'coder',
    })
    expect(messageId).toBeTypeOf('number')

    const artifacts = listArtifactsForMessages(db, USER_ID, [messageId!]).get(messageId!) ?? []
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'html',
      source: 'upload',
      strandId: SESSION_ID,
      messageId: messageId!,
    })
  })

  it('records an inline html fence the injection wrote', () => {
    const transcript = new TaskInjectionTranscript()
    transcript.record({ type: 'text', text: '```html Wheel report\n<p>hi</p>\n```' })

    const messageId = transcript.persist(db, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      agentId: 'coder',
    })
    const artifacts = listArtifactsForMessages(db, USER_ID, [messageId!]).get(messageId!) ?? []
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.title).toBe('Wheel report')
    expect(artifacts[0]!.source).toBe('inline_fence')
  })
})
