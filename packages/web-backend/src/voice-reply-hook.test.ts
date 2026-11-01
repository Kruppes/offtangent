/**
 * The automatic voice note after a finished answer.
 *
 * Checks the switch (on -> generated + broadcast, off -> nothing), that a
 * failing voice never escapes into the turn, that an empty answer is skipped,
 * and that the note lands on the message without losing its attachments.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  initDatabase,
  setVoiceRepliesEnabled,
  TurnRunner,
  VoiceNoteUpstreamError,
  type CreatedVoiceNote,
  type Database,
} from '@axiom/core'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { createVoiceReplyHook } from './voice-reply-hook.js'
import { clearVoiceNoteInFlight } from './api/modules/speech/voice-note-runner.js'

let db: Database
let runs = 0
let fail = false

function generated(raw: string): CreatedVoiceNote {
  return {
    voiceNote: {
      url: `/api/uploads/voice-note-${runs}.ogg`,
      mimeType: 'audio/ogg',
      seconds: 8.2,
      spokenChars: 90,
      sourceChars: raw.length,
      model: 'gemini-3.8-flash-lite-tts',
      voice: 'Charon',
      createdAt: '2026-09-24T10:00:00.000Z',
    },
    upload: {
      kind: 'file', originalName: 'voice-note.ogg', storedName: 'voice-note.ogg',
      relativePath: '2026/voice-note.ogg', urlPath: `/api/uploads/voice-note-${runs}.ogg`,
      mimeType: 'audio/ogg', size: 2048,
    },
    script: { text: 'Kurzfassung.', language: 'de', sourceChars: raw.length, summaryChars: 12, model: 'test:model', passthrough: false },
    chunks: 1,
    usage: { promptTokens: 22, completionTokens: 410 },
  }
}

function insertMessage(content: string, metadata: string | null = null): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
     VALUES ('strand-1', 1, 'assistant', ?, ?, 'main')`,
  ).run(content, metadata)
  return Number(result.lastInsertRowid)
}

function makeHook(bus: ChatEventBus, errors: string[] = []) {
  return createVoiceReplyHook({
    db,
    chatEventBus: bus,
    generate: async raw => {
      runs += 1
      if (fail) throw new VoiceNoteUpstreamError('the voice said no')
      return generated(raw)
    },
    logger: { warn: msg => errors.push(msg), error: msg => errors.push(msg) },
  })
}

beforeEach(() => {
  db?.close()
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, type) VALUES ('strand-1', 1, 'main', 'interactive')").run()
  runs = 0
  fail = false
  clearVoiceNoteInFlight()
})

afterAll(() => { db?.close() })

describe('createVoiceReplyHook', () => {
  it('does nothing while the switch is off', async () => {
    const bus = new ChatEventBus()
    const frames: ChatEvent[] = []
    bus.subscribe(event => frames.push(event))

    const id = insertMessage('Der Lauf ist durch.')
    await makeHook(bus).handle({ messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Der Lauf ist durch.' })

    expect(runs).toBe(0)
    expect(frames).toHaveLength(0)
    expect(db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id)).toEqual({ metadata: null })
  })

  it('speaks the answer and broadcasts the frame while the switch is on', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const bus = new ChatEventBus()
    const frames: ChatEvent[] = []
    bus.subscribe(event => frames.push(event))

    const id = insertMessage('Der Lauf ist durch.')
    await makeHook(bus).handle({ messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Der Lauf ist durch.' })

    expect(runs).toBe(1)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      type: 'voice_note', userId: 1, sessionId: 'strand-1', messageId: id, agentId: 'main',
    })
    expect(frames[0]!.voiceNote!.url).toBe('/api/uploads/voice-note-1.ogg')

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id) as { metadata: string }
    expect(JSON.parse(row.metadata).voiceNote.url).toBe('/api/uploads/voice-note-1.ogg')
  })

  it('never speaks an answer of a strand with private (local_only) MCP data', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('strand-1', 1, 'tool', 'Tool: mcp_x_read', ?, 'main')")
      .run(JSON.stringify({ toolName: 'mcp_x_read', toolResult: { content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_7731' }], details: { mcpDataClass: 'local_only' } } }))
    const spoken: string[] = []
    const hook = createVoiceReplyHook({
      db,
      chatEventBus: new ChatEventBus(),
      generate: async raw => { spoken.push(raw); runs += 1; return generated(raw) },
      logger: { warn: () => {}, error: () => {} },
    })
    const id = insertMessage('Quote: PRIVATE_SYNTHETIC_7731')
    await hook.handle({ messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Quote: PRIVATE_SYNTHETIC_7731' })
    expect(spoken).toEqual([])
    expect(runs).toBe(0)
  })

  it('keeps the attachments of the answer', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const metadata = JSON.stringify({ files: [{ urlPath: '/api/uploads/report.pdf' }] })
    const id = insertMessage('Bericht liegt bei.', metadata)

    await makeHook(new ChatEventBus()).handle({ messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Bericht liegt bei.' })

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id) as { metadata: string }
    const parsed = JSON.parse(row.metadata)
    expect(parsed.files).toEqual([{ urlPath: '/api/uploads/report.pdf' }])
    expect(parsed.voiceNote.url).toBe('/api/uploads/voice-note-1.ogg')
  })

  it('skips an answer that carries no text', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const id = insertMessage('')
    await makeHook(new ChatEventBus()).handle({ messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: '   ' })
    expect(runs).toBe(0)
  })

  it('swallows a failing voice and logs its class, not the provider text (review K0-K2-5 #1)', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    fail = true
    const errors: string[] = []
    const id = insertMessage('Der Lauf ist durch.')

    // Resolves — the turn behind it must not see the failure.
    await expect(makeHook(new ChatEventBus(), errors).handle({
      messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Der Lauf ist durch.',
    })).resolves.toBeUndefined()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(`Voice note for message ${id} failed: error`)
    expect(errors[0]).not.toContain('the voice said no')
    expect(db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id)).toEqual({ metadata: null })
  })

  it('a provider error echoing the answer never reaches the log (review K0-K2-5 #1)', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const marker = 'PRIVATE_CLOCK_DICTATION_MARKER_007'
    const errors: string[] = []
    const hook = createVoiceReplyHook({
      db,
      generate: async () => { throw new Error(`401 provider echoed answer: ${marker}`) },
      logger: { warn: msg => errors.push(msg), error: msg => errors.push(msg) },
    })
    const id = insertMessage(`Antwort ${marker}`)
    await hook.handle({ messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: `Antwort ${marker}` })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('failed: auth')
    expect(errors.join('\n')).not.toContain(marker)
  })

  it('skips a clock turn: the clock speaks its answer itself (review K0-K2-5 #1)', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const bus = new ChatEventBus()
    const frames: ChatEvent[] = []
    bus.subscribe(event => frames.push(event))
    const id = insertMessage('Die Uhr hat es schon gesagt.')
    await makeHook(bus).handle({
      messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Die Uhr hat es schon gesagt.', source: 'clock',
    })
    expect(runs).toBe(0)
    expect(frames).toHaveLength(0)
    expect(db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id)).toEqual({ metadata: null })
    // Any other channel still gets its voice.
    await makeHook(bus).handle({
      messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Die Uhr hat es schon gesagt.', source: 'telegram',
    })
    expect(runs).toBe(1)
  })

  it('TurnRunner -> hook: a clock turn never reaches the voice, a web turn logs only the class (review K0-K2-5 #1)', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const marker = 'PRIVATE_CLOCK_DICTATION_MARKER_007'
    const errors: string[] = []
    let generateCalls = 0
    const pending: Promise<void>[] = []
    const hook = createVoiceReplyHook({
      db,
      generate: async () => { generateCalls += 1; throw new Error(`provider echoed answer: ${marker}`) },
      logger: { warn: msg => errors.push(msg), error: msg => errors.push(msg) },
    })
    const agent = {
      sendMessage: async function* () { yield { type: 'text', text: `Antwort ${marker}` }; yield { type: 'done' } },
      abort() {},
    }
    const runner = new TurnRunner({
      db,
      getAgent: () => agent as never,
      onAssistantMessage: message => { pending.push(hook.handle(message)) },
    })
    const settle = async () => {
      const deadline = Date.now() + 3000
      while (runner.hasActiveTurn(1)) {
        if (Date.now() > deadline) throw new Error('turn not settled')
        await new Promise(r => setTimeout(r, 10))
      }
      await Promise.all(pending.splice(0))
    }

    runner.startTurn({ userId: 1, sessionId: 'strand-1', text: `diktat ${marker}`, source: 'clock' })
    await settle()
    expect(generateCalls).toBe(0)
    expect(errors).toHaveLength(0)

    runner.startTurn({ userId: 1, sessionId: 'strand-1', text: 'web frage', source: 'web' })
    await settle()
    expect(generateCalls).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors.join('\n')).not.toContain(marker)
  })

  it('does not speak the same answer twice', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const hook = makeHook(new ChatEventBus())
    const id = insertMessage('Der Lauf ist durch.')
    const message = { messageId: id, userId: 1, sessionId: 'strand-1', agentId: 'main', content: 'Der Lauf ist durch.' }

    await hook.handle(message)
    await hook.handle(message)

    expect(runs).toBe(1)
  })

  it('leaves another user alone', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'other', 'x', 'user')").run()
    const id = insertMessage('Der Lauf ist durch.')

    await makeHook(new ChatEventBus()).handle({ messageId: id, userId: 2, sessionId: 'strand-1', agentId: 'main', content: 'Der Lauf ist durch.' })
    expect(runs).toBe(0)
  })
})

describe('voice reply hook + send_voice_message', () => {
  it('does not speak again when the turn already carries a tool voice note', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    const bus = new ChatEventBus()
    const frames: ChatEvent[] = []
    bus.subscribe(event => { frames.push(event) })
    const before = runs

    const id = insertMessage('Die Antwort steht.', JSON.stringify({
      voiceNote: {
        url: '/api/uploads/tool-note.ogg',
        mimeType: 'audio/ogg',
        seconds: 3.1,
        spokenChars: 18,
        sourceChars: 18,
        model: 'test-model',
        voice: 'test-voice',
        createdAt: '2026-09-24T10:00:00.000Z',
      },
    }))
    await makeHook(bus).handle({
      messageId: id,
      userId: 1,
      sessionId: 'strand-1',
      agentId: 'main',
      content: 'Die Antwort steht.',
      voiceNote: {
        url: '/api/uploads/tool-note.ogg',
        mimeType: 'audio/ogg',
        seconds: 3.1,
        spokenChars: 18,
        sourceChars: 18,
        model: 'test-model',
        voice: 'test-voice',
        createdAt: '2026-09-24T10:00:00.000Z',
      },
    })

    // No second generation, and the frame still went out exactly once.
    expect(runs).toBe(before)
    const voiceFrames = frames.filter(f => f.type === 'voice_note')
    expect(voiceFrames).toHaveLength(1)
    expect((voiceFrames[0] as { voiceNote: { url: string } }).voiceNote.url).toBe('/api/uploads/tool-note.ogg')
  })
})
