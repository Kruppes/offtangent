import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSendFileTool, initDatabase } from '@axiom/core'
import type { Database, SendFileDelivery, UploadDescriptor } from '@axiom/core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { deliverTaskFile } from './task-file-delivery.js'
import { strandHasLiveWriter } from './bootstrap/runtime-composition.js'

/**
 * The interactive half of `send_file_to_user`, wired exactly like
 * `runtime-composition.ts` wires it: the carrier predicate
 * (`strandHasLiveWriter`) plus `deliverTaskFile` as the fallback sink, against
 * a real database.
 *
 * Forensic background (live DB, 2026-09-15): two APKs the persona sent with
 * `send_file_to_user` at 07:56:26 and 08:02:38 (tool_calls 104428 / 104440,
 * strand 8b13c99b-…) never reached a `chat_messages` row. Both were sent while
 * the persona was reacting to a finished task, and the reaction's assistant
 * rows (89533 / 89552) carry `{"type":"task_injection_response"}` metadata with
 * no `files` array — the injection transcript did not record uploads yet. The
 * tool answered "The user sees a download card on this turn" in both cases.
 *
 * These tests pin the three interactive outcomes that follow from that:
 * a live writer carries the file, no live writer still delivers it through the
 * sink, and a delivery nobody performed is reported as an error.
 */

function textOf(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function detailsOf(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

const STRAND = 'strand-8b13c99b'

describe('an interactive persona sending a file', () => {
  let dataDir: string
  let workspaceDir: string
  let originalEnv: { DATA_DIR?: string; WORKSPACE_DIR?: string }
  let db: Database
  let bus: ChatEventBus
  let events: ChatEvent[]
  /** Stand-ins for the two live writers the composition knows about. */
  let turnsByStrand: Set<string>
  let injectionsByStrand: Set<string>

  function makeTool(): AgentTool {
    return createSendFileTool({
      getCurrentToolUserId: () => 3,
      getCurrentInteractiveSessionId: () => STRAND,
      isCarriedByCurrentTurn: () => strandHasLiveWriter(STRAND, {
        hasPersistingTurn: (sessionId) => turnsByStrand.has(sessionId),
        hasLiveInjection: (sessionId) => injectionsByStrand.has(sessionId),
      }),
      deliverFile: (delivery: SendFileDelivery) => deliverTaskFile({ db, chatEventBus: bus }, {
        userId: delivery.userId,
        sessionId: delivery.sessionId,
        agentId: 'bob',
        upload: delivery.upload,
        caption: delivery.caption,
      }),
    })
  }

  function attachmentRows(): Array<{ id: number; session_id: string; metadata: string }> {
    return db.prepare(
      "SELECT id, session_id, metadata FROM chat_messages WHERE role = 'assistant' ORDER BY id"
    ).all() as Array<{ id: number; session_id: string; metadata: string }>
  }

  beforeEach(() => {
    originalEnv = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-interactive-send-file-'))
    workspaceDir = path.join(dataDir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true })
    process.env.DATA_DIR = dataDir
    process.env.WORKSPACE_DIR = workspaceDir

    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'alice', 'x', 'admin')").run()
    bus = new ChatEventBus()
    events = []
    bus.subscribe((event) => { events.push(event) })
    turnsByStrand = new Set()
    injectionsByStrand = new Set()

    fs.writeFileSync(path.join(workspaceDir, 'offtangent.apk'), 'apk-bytes')
  })

  afterEach(() => {
    process.env.DATA_DIR = originalEnv.DATA_DIR
    process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('stays passive while a live turn persists the strand, so the file is not written twice', async () => {
    turnsByStrand.add(STRAND)

    const result = await makeTool().execute('call-turn', { path: 'offtangent.apk', caption: 'Release' })

    expect(detailsOf(result).error).toBeFalsy()
    expect(textOf(result)).toMatch(/download card on this turn/)
    // The TurnRunner transcript writes the row at the end of the turn; the
    // tool must not add a second one.
    expect(attachmentRows()).toHaveLength(0)
  })

  it('stays passive while a task-injection reaction is streaming into the strand', async () => {
    injectionsByStrand.add(STRAND)

    const result = await makeTool().execute('call-injection', { path: 'offtangent.apk' })

    expect(detailsOf(result).error).toBeFalsy()
    expect(attachmentRows()).toHaveLength(0)
  })

  it('delivers the file itself when no writer is persisting the strand', async () => {
    // Exactly the shape of the 2026-09-15 losses: an interactive-looking
    // context with nothing writing history. Before the fix the tool answered
    // "The user sees a download card on this turn" and the APK stayed in
    // /data/uploads with no row pointing at it.
    const result = await makeTool().execute('call-orphan', {
      path: 'offtangent.apk',
      filename: 'offtangent-0.9.1-cards.apk',
      caption: 'Diese APK ersetzt die vorige',
    })

    expect(detailsOf(result).error).toBeFalsy()

    const rows = attachmentRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe(STRAND)
    const meta = JSON.parse(rows[0]!.metadata) as { files: UploadDescriptor[] }
    expect(meta.files).toHaveLength(1)
    expect(meta.files[0]!.originalName).toBe('offtangent-0.9.1-cards.apk')
    expect(meta.files[0]!.caption).toBe('Diese APK ersetzt die vorige')

    // The answer names the row, and the row id it names is the row that exists.
    expect(detailsOf(result).messageId).toBe(rows[0]!.id)
    expect(textOf(result)).toContain(`message #${rows[0]!.id}`)
    expect(textOf(result)).not.toMatch(/download card on this turn/)

    // A live client gets the card immediately, attributed to that row.
    const attachments = events.filter(e => e.type === 'attachment')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.sessionId).toBe(STRAND)
    expect(attachments[0]!.messageId).toBe(rows[0]!.id)
  })

  it('reports an error instead of success when the strand cannot be resolved', async () => {
    const tool = createSendFileTool({
      getCurrentToolUserId: () => 3,
      // No strand: nothing to deliver into, and no writer either.
      getCurrentInteractiveSessionId: () => null,
      isCarriedByCurrentTurn: () => strandHasLiveWriter(null, {
        hasPersistingTurn: () => true,
        hasLiveInjection: () => true,
      }),
      deliverFile: (delivery: SendFileDelivery) => deliverTaskFile({ db, chatEventBus: bus }, {
        userId: delivery.userId,
        sessionId: delivery.sessionId,
        agentId: 'bob',
        upload: delivery.upload,
        caption: delivery.caption,
      }),
    })

    const result = await tool.execute('call-no-strand', { path: 'offtangent.apk' })

    expect(detailsOf(result)).toMatchObject({ error: true })
    expect(textOf(result)).toMatch(/no strand to deliver the file to/)
    expect(attachmentRows()).toHaveLength(0)
  })

  it('delivers every file when the same turn sends several, one row each', async () => {
    // The old field report was "several send_file_to_user calls in one turn do
    // not arrive". Without a live writer each call now writes its own row.
    fs.writeFileSync(path.join(workspaceDir, 'second.apk'), 'more-bytes')
    const tool = makeTool()

    await tool.execute('call-multi-1', { path: 'offtangent.apk', filename: 'first.apk' })
    await tool.execute('call-multi-2', { path: 'second.apk', filename: 'second.apk' })

    const rows = attachmentRows()
    expect(rows).toHaveLength(2)
    const names = rows.map(r => (JSON.parse(r.metadata) as { files: UploadDescriptor[] }).files[0]!.originalName)
    expect(names).toEqual(['first.apk', 'second.apk'])
  })
})
