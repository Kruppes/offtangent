/**
 * Split-on-intake in the captures service: a dictation that mixes two matters
 * becomes two parts, each with its own router decision, its own strand and its
 * own apply/undo, plus the "keep as one" escape hatch.
 *
 * Both models are stubbed: `splitComplete` answers the two split stages,
 * `routerComplete` the router, one call per part.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager, STAGE1_SYSTEM_PROMPT } from '@axiom/core'
import type { AgentCore, Database, ResolvedRouterModel } from '@axiom/core'
import { createCapturesService } from './service.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'

let db: Database
let tempDataDir: string
let previousDataDir: string | undefined
let events: ChatEvent[] = []
let turns: Array<{ sessionId: string; text: string }> = []
let routerAnswers: string[] = []
let splitAnswers: string[] = []
let splitCalls: string[] = []
let service: ReturnType<typeof createCapturesService>

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

const DACH = 'Das Dach tropft seit dem Sturm.'
const DACH2 = 'Ich brauche endlich einen Dachdecker.'
const AUTO = 'Das Auto muss zum Service.'
const AUTO2 = 'Der Termin waere am Montag.'
const TEXT = `${DACH} ${DACH2} ${AUTO} ${AUTO2}`

const TWO_TOPICS = JSON.stringify({
  topics: [
    { id: 'A', title: 'Dach', sentenceIds: [1, 2] },
    { id: 'B', title: 'Auto', sentenceIds: [3, 4] },
  ],
  uncertain: [],
  splitConfidence: 0.93,
  rationale: 'Dach und Auto sind zwei getrennte Sachen',
})

const DACH_PART = 'Das Dach tropft seit dem Sturm, ich brauche einen Dachdecker.'
const AUTO_PART = 'Das Auto muss zum Service, Termin am Montag.'

function newStrand(title: string, confidence: number, intent: 'note' | 'ask' = 'note'): string {
  return JSON.stringify({
    action: 'new_strand', strandId: null, secondaryStrandId: null,
    newStrand: { title, personaId: 'main', tags: [], projectId: null },
    intent, confidence, tags: [], rationale: `strand ${title}`, alternatives: [],
  })
}

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-split-parts-'))
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
    routerComplete: async () => {
      const next = routerAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
    splitComplete: async (system, user) => {
      splitCalls.push(system === STAGE1_SYSTEM_PROMPT ? 'stage1' : `stage2:${user.split('\n')[0]}`)
      const next = splitAnswers.shift()
      if (next === undefined) throw new Error('split stub has no answer')
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
  routerAnswers = []
  splitAnswers = []
  splitCalls = []
  // One candidate strand, otherwise the router answers synthetically without
  // ever calling the stub (no candidates means "new strand" by definition).
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
     VALUES ('s-existing', 1, '1', 'interactive', 'main', 'Dachrinne', datetime('now','-1 day'), datetime('now','-1 day'), 0)`,
  ).run()
})

async function createSplitCapture(options: { confidences?: [number, number]; intents?: Array<'note' | 'ask'> } = {}) {
  const [c0, c1] = options.confidences ?? [0.9, 0.9]
  const [i0, i1] = options.intents ?? ['note', 'note']
  splitAnswers = [TWO_TOPICS, DACH_PART, AUTO_PART]
  routerAnswers = [newStrand('Dach', c0, i0), newStrand('Auto', c1, i1)]
  return service.createCapture(1, {
    text: TEXT, clientMessageId: null, agentId: null, strandId: null,
    kind: 'voice', source: 'puck', attachments: [], intent: null, mode: 'work',
  })
}

describe('split on intake', () => {
  it('files two parts into two strands with one decision each', async () => {
    const result = await createSplitCapture()

    expect(splitCalls[0]).toBe('stage1')
    expect(splitCalls.slice(1).sort()).toEqual(['stage2:Topic: Auto', 'stage2:Topic: Dach'])

    const decisions = db.prepare(
      'SELECT part_index, part_count, part_text, part_title, sentence_ids, state, target_strand_id FROM router_decisions ORDER BY part_index',
    ).all() as Array<Record<string, unknown>>
    expect(decisions).toHaveLength(2)
    expect(decisions[0].part_index).toBe(0)
    expect(decisions[0].part_count).toBe(2)
    expect(decisions[0].part_text).toBe(DACH_PART)
    expect(decisions[0].part_title).toBe('Dach')
    expect(decisions[0].sentence_ids).toBe('[1,2]')
    expect(decisions[0].state).toBe('applied')
    expect(decisions[1].part_text).toBe(AUTO_PART)
    expect(decisions[1].sentence_ids).toBe('[3,4]')
    expect(decisions[0].target_strand_id).not.toBe(decisions[1].target_strand_id)

    const rows = db.prepare('SELECT session_id, content, metadata, part_index FROM chat_messages ORDER BY part_index').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0].content).toBe(DACH_PART)
    expect(rows[1].content).toBe(AUTO_PART)
    expect(JSON.parse(String(rows[1].metadata))).toEqual({ capturePart: { index: 1, count: 2, captureId: result.capture.id } })

    // The capture keeps the ORIGINAL text and is bound to part 0.
    expect(result.capture.text).toBe(TEXT)
    expect(result.capture.strandId).toBe(rows[0].session_id)
    expect(result.capture.status).toBe('filed')

    // One frame per capture, top-level fields from part 0, parts additive.
    const routed = events.filter(e => e.type === 'capture_routed' || e.type === 'capture_needs_review')
    expect(routed).toHaveLength(1)
    expect(routed[0].decision!.partIndex).toBe(0)
    expect(routed[0].partCount).toBe(2)
    // `parts` on the frame has the shape of `GET /api/captures/:id`: the part
    // with its own text, sentence ids and decision, never a bare decision.
    expect(routed[0].parts!.map(p => [p.index, p.title, p.text, p.sentenceIds])).toEqual([
      [0, 'Dach', DACH_PART, [1, 2]],
      [1, 'Auto', AUTO_PART, [3, 4]],
    ])
    expect(routed[0].parts!.map(p => p.decision.partIndex)).toEqual([0, 1])
  })

  it('aggregates the capture status over the parts', async () => {
    const result = await createSplitCapture({ confidences: [0.9, 0.5] })
    expect(result.capture.status).toBe('needs_review')
    const view = service.get(1, result.capture.id)
    expect(view.partCount).toBe(2)
    expect(view.parts.map(p => p.title)).toEqual(['Dach', 'Auto'])
    expect(view.parts.map(p => p.text)).toEqual([DACH_PART, AUTO_PART])
    expect(view.parts.map(p => p.sentenceIds)).toEqual([[1, 2], [3, 4]])
    expect(view.split.confidence).toBe(0.93)
    expect(view.split.rationale).toBe('Dach und Auto sind zwei getrennte Sachen')
    expect(view.split.gated).toBe(false)
    expect(view.capture.text).toBe(TEXT)
  })

  it('starts a turn per ask part with the fragment line in the prompt', async () => {
    const result = await createSplitCapture({ intents: ['note', 'ask'] })
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe(`[Teil 2 von 2 einer Sprachnotiz; Original: capture ${result.capture.id}]\n${AUTO_PART}`)
    // The stored row never carries the line.
    const stored = db.prepare('SELECT content FROM chat_messages WHERE part_index = 1').get() as { content: string }
    expect(stored.content).toBe(AUTO_PART)
  })

  it('undoes one part and leaves the other filed', async () => {
    const created = await createSplitCapture()
    const undone = service.undo(1, created.capture.id, { strandId: null, partIndex: 1 })
    expect(undone.capture.status).toBe('needs_review')
    const rows = db.prepare('SELECT part_index FROM chat_messages').all() as Array<{ part_index: number }>
    expect(rows.map(r => r.part_index)).toEqual([0])
    const parts = service.get(1, created.capture.id).parts
    expect(parts[0].decision.state).toBe('applied')
    expect(parts[1].decision.state).toBe('undone')
    expect(undone.capture.strandId).not.toBeNull()
  })

  it('undoes every part without a partIndex and puts the capture in the tray', async () => {
    const created = await createSplitCapture()
    const undone = service.undo(1, created.capture.id, { strandId: null, partIndex: null })
    expect(undone.capture.status).toBe('unsorted')
    expect(undone.capture.strandId).toBeNull()
    expect(undone.capture.messageId).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()).toEqual({ c: 0 })
    const parts = service.get(1, created.capture.id).parts
    expect(parts.map(p => p.decision.state)).toEqual(['undone', 'undone'])
  })

  it('applies one part again after it was undone', async () => {
    const created = await createSplitCapture()
    service.undo(1, created.capture.id, { strandId: null, partIndex: null })
    const applied = service.apply(1, created.capture.id, {
      decisionId: null, action: null, strandId: null, title: null, personaId: null, partIndex: 1,
    })
    expect(applied.capture.status).toBe('needs_review')
    const rows = db.prepare('SELECT content, part_index FROM chat_messages').all() as Array<{ content: string; part_index: number }>
    expect(rows).toEqual([{ content: AUTO_PART, part_index: 1 }])
  })

  it('keeps the capture as one on request', async () => {
    const created = await createSplitCapture()
    routerAnswers = [newStrand('Alles zusammen', 0.9)]
    const kept = await service.keepAsOne(1, created.capture.id)

    expect(kept.decision.partCount).toBe(1)
    expect(kept.decision.partText).toBeNull()
    expect(kept.capture.status).toBe('filed')
    const rows = db.prepare('SELECT content, part_index, metadata FROM chat_messages').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe(TEXT)
    expect(rows[0].part_index).toBe(0)
    expect(rows[0].metadata).toBeNull()
    // The old part decisions are gone from the current view, superseded.
    const states = db.prepare('SELECT state FROM router_decisions ORDER BY rowid').all() as Array<{ state: string }>
    expect(states.filter(s => s.state === 'superseded').length).toBeGreaterThanOrEqual(2)
    const view = service.get(1, created.capture.id)
    expect(view.partCount).toBe(1)
    expect(view.parts[0].text).toBe(TEXT)
    // No split model call happened for the re-route.
    expect(splitCalls.filter(c => c === 'stage1')).toHaveLength(1)
  })

  it('files a gated split as one capture', async () => {
    splitAnswers = [JSON.stringify({
      topics: [
        { id: 'A', title: 'Dach', sentenceIds: [1, 2] },
        { id: 'B', title: 'Auto', sentenceIds: [3, 4] },
      ],
      uncertain: [],
      splitConfidence: 0.4,
      rationale: 'unsicher',
    })]
    routerAnswers = [newStrand('Alles', 0.9)]
    const result = await service.createCapture(1, {
      text: TEXT, clientMessageId: null, agentId: null, strandId: null,
      kind: 'voice', source: 'puck', attachments: [], intent: null, mode: 'work',
    })
    expect(result.decision.partCount).toBe(1)
    const rows = db.prepare('SELECT content FROM chat_messages').all() as Array<{ content: string }>
    expect(rows).toEqual([{ content: TEXT }])
    const view = service.get(1, result.capture.id)
    expect(view.split.gated).toBe(true)
    expect(view.split.confidence).toBe(0.4)
  })

  it('never splits an assist capture', async () => {
    routerAnswers = [newStrand('Assist', 0.9)]
    const result = await service.createCapture(1, {
      text: TEXT, clientMessageId: null, agentId: null, strandId: null,
      kind: 'voice', source: 'puck', attachments: [], intent: null, mode: 'assist',
    })
    expect(splitCalls).toHaveLength(0)
    expect(result.decision.partCount).toBe(1)
  })

  it('lists the parts of every capture', async () => {
    const created = await createSplitCapture()
    const listed = service.list(1, { status: 'all', limit: 50, offset: 0 })
    expect(listed.decisions).toHaveLength(1)
    expect(listed.decisions[0].partIndex).toBe(0)
    expect(listed.parts[created.capture.id].map(p => p.index)).toEqual([0, 1])
    expect(listed.parts[created.capture.id][1].text).toBe(AUTO_PART)
  })
})
