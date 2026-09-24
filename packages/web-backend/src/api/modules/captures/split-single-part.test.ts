/**
 * The regression guard of split-on-intake: a short text capture must behave
 * EXACTLY as it did before parts existed. The fixture below was recorded
 * against the service on `main` (commit bb3961f1) before the split pipeline
 * was written, and it pins what the client sees: the router prompt, the two
 * broadcast frames, the capture row, the decision row and the chat row.
 *
 * A failure here means the single topic path changed, which is the one thing
 * this feature must not do.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, ResolvedRouterModel } from '@axiom/core'
import { createCapturesService } from './service.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'

let db: Database
let tempDataDir: string
let previousDataDir: string | undefined
let events: ChatEvent[] = []
let turns: Array<{ sessionId: string; text: string }> = []
let prompts: string[] = []
let nextAnswers: string[] = []
let service: ReturnType<typeof createCapturesService>

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-split-single-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  const sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))
  service = createCapturesService({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: bus,
    getTurnRunner: () => ({ startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text }); return {} } }),
    routerChain: () => chain,
    getNowSetMode: () => 'manual',
    routerComplete: async (_entry, prompt) => {
      prompts.push(prompt)
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
  })
})

afterAll(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM tags; DELETE FROM strand_tags; DELETE FROM now_set;')
  events = []
  turns = []
  prompts = []
  nextAnswers = []
})

const SHORT_TEXT = 'Winterreifen fuer den Kombi besorgen.'

const NEW_STRAND_ANSWER = JSON.stringify({
  action: 'new_strand',
  strandId: null,
  secondaryStrandId: null,
  newStrand: { title: 'Winterreifen', personaId: 'main', tags: ['auto'], projectId: null },
  intent: 'note',
  confidence: 0.86,
  tags: ['auto'],
  rationale: 'Nothing matches yet',
  alternatives: [],
})

describe('single part capture behaves exactly as before the split', () => {
  it('writes one decision, one chat row and two frames', async () => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
       VALUES ('s-existing', 1, '1', 'interactive', 'main', 'Dachrinne', datetime('now','-1 day'), datetime('now','-1 day'), 0)`,
    ).run()
    nextAnswers = [NEW_STRAND_ANSWER]

    const result = await service.createCapture(1, {
      text: SHORT_TEXT, clientMessageId: null, agentId: null, strandId: null,
      kind: 'text', source: 'web', attachments: [], intent: null, mode: 'work',
    })

    // No split model call: the stub only ever answered the router.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(SHORT_TEXT)

    expect(result.created).toBe(true)
    expect(result.capture.status).toBe('filed')
    expect(result.capture.text).toBe(SHORT_TEXT)
    expect(result.capture.strandId).not.toBeNull()
    expect(result.capture.messageId).not.toBeNull()
    expect(result.decision.action).toBe('new_strand')
    expect(result.decision.confidence).toBe(0.86)
    expect(result.decision.intent).toBe('note')
    expect(result.decision.state).toBe('applied')
    expect(result.decision.partIndex).toBe(0)
    expect(result.decision.partCount).toBe(1)
    expect(result.decision.partText).toBeNull()
    expect(result.decision.partTitle).toBeNull()
    expect(result.decision.sentenceIds).toEqual([])

    const decisionRows = db.prepare(
      'SELECT capture_id, action, intent, confidence, state, part_index, part_count, part_text, part_title, sentence_ids FROM router_decisions',
    ).all()
    expect(decisionRows).toEqual([{
      capture_id: result.capture.id,
      action: 'new_strand',
      intent: 'note',
      confidence: 0.86,
      state: 'applied',
      part_index: 0,
      part_count: 1,
      part_text: null,
      part_title: null,
      sentence_ids: null,
    }])

    const chatRows = db.prepare(
      'SELECT session_id, role, content, metadata, capture_id, part_index FROM chat_messages',
    ).all()
    expect(chatRows).toEqual([{
      session_id: result.capture.strandId,
      role: 'user',
      content: SHORT_TEXT,
      metadata: null,
      capture_id: result.capture.id,
      part_index: 0,
    }])

    // The frames, in the order and shape the app 0.16.x reads.
    expect(events.map(e => e.type)).toEqual(['now_set_changed', 'user_message', 'capture_routed'])
    const userMessage = events[1] as ChatEvent & { text: string; sessionId: string }
    expect(userMessage.text).toBe(SHORT_TEXT)
    expect(userMessage.sessionId).toBe(result.capture.strandId)
    const routed = events[2] as ChatEvent & { capture: { id: string }; decision: { action: string } }
    expect(routed.capture.id).toBe(result.capture.id)
    expect(routed.decision.action).toBe('new_strand')
    // A note starts no turn.
    expect(turns).toHaveLength(0)
  })

  it('applies and undoes without a partIndex exactly as before', async () => {
    nextAnswers = [JSON.stringify({
      action: 'new_strand', strandId: null, secondaryStrandId: null,
      newStrand: { title: 'Winterreifen', personaId: 'main', tags: [], projectId: null },
      intent: 'note', confidence: 0.2, tags: [], rationale: 'unsure', alternatives: [],
    })]
    const created = await service.createCapture(1, {
      text: SHORT_TEXT, clientMessageId: null, agentId: null, strandId: null,
      kind: 'text', source: 'web', attachments: [], intent: null, mode: 'work',
    })
    // No candidate strand exists, so the router answers synthetically at 0.5:
    // the medium band files and keeps the card reviewable.
    expect(created.capture.status).toBe('needs_review')

    const applied = service.apply(1, created.capture.id, { decisionId: null, action: null, strandId: null, title: null, personaId: null, partIndex: null })
    expect(applied.capture.status).toBe('filed')
    expect(applied.decision.state).toBe('confirmed')
    expect(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()).toEqual({ c: 1 })

    const undone = service.undo(1, created.capture.id, { strandId: null, partIndex: null })
    expect(undone.capture.status).toBe('unsorted')
    expect(undone.capture.strandId).toBeNull()
    expect(undone.capture.messageId).toBeNull()
    expect(undone.decision.state).toBe('undone')
    expect(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()).toEqual({ c: 0 })
  })
})
