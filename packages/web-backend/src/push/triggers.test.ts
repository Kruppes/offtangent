import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import type { PushDoorbell, PushSender } from './sender.js'
import { isPushableSession, latestAssistantMessageId, sendCaptureDoorbell, sendTaskDoorbell, sendTurnDoorbell } from './triggers.js'
import { priorityFor } from './sender.js'

let db: Database
let sent: PushDoorbell[]
let sender: PushSender

function seedSession(id: string, type: string): void {
  db.prepare('INSERT INTO sessions (id, user_id, type, source) VALUES (?, ?, ?, ?)').run(id, 1, type, 'web')
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'alice', 'x')
  sent = []
  sender = { sendDetached: (doorbell: PushDoorbell) => { sent.push(doorbell) } } as unknown as PushSender
})

afterEach(() => {
  db.close()
})

describe('doorbell triggers', () => {
  it('rings for an interactive strand', () => {
    seedSession('s-1', 'interactive')
    expect(isPushableSession(db, 's-1')).toBe(true)
  })

  it('stays silent for heartbeats, consolidations and task sessions', () => {
    seedSession('s-hb', 'heartbeat')
    seedSession('s-co', 'consolidation')
    seedSession('s-task', 'task')
    expect(isPushableSession(db, 's-hb')).toBe(false)
    expect(isPushableSession(db, 's-co')).toBe(false)
    expect(isPushableSession(db, 's-task')).toBe(false)
  })

  it('stays silent for a session that does not exist', () => {
    expect(isPushableSession(db, 'nope')).toBe(false)
  })

  it('sends turn_done with the newest assistant row as the cursor', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s-1', 1, 'user', 'hi')").run()
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s-1', 1, 'assistant', 'there')").run()
    const expected = latestAssistantMessageId(db, 's-1')

    sendTurnDoorbell(db, sender, { userId: 1, sessionId: 's-1', agentId: 'bob', failed: false })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'turn_done', strandId: 's-1', agentId: 'bob', messageId: expected })
  })

  it('sends error when the turn died', () => {
    seedSession('s-1', 'interactive')
    sendTurnDoorbell(db, sender, { userId: 1, sessionId: 's-1', agentId: 'main', failed: true })
    expect(sent[0].kind).toBe('error')
  })

  it('skips a turn without a linked web user', () => {
    seedSession('s-1', 'interactive')
    sendTurnDoorbell(db, sender, { userId: null, sessionId: 's-1', agentId: 'main', failed: false })
    expect(sent).toHaveLength(0)
  })

  it('maps the three task events onto their kinds', () => {
    seedSession('s-1', 'interactive')
    sendTaskDoorbell(db, sender, { userId: 1, sessionId: 's-1', agentId: 'main', type: 'task_completed' })
    sendTaskDoorbell(db, sender, { userId: 1, sessionId: 's-1', agentId: 'main', type: 'task_failed' })
    sendTaskDoorbell(db, sender, { userId: 1, sessionId: 's-1', agentId: 'main', type: 'task_question' })
    expect(sent.map(d => d.kind)).toEqual(['task_done', 'error', 'question'])
  })

  it('skips a task notification without a target strand', () => {
    sendTaskDoorbell(db, sender, { userId: 1, sessionId: undefined, agentId: 'main', type: 'task_completed' })
    expect(sent).toHaveLength(0)
  })

  it('rings a capture question as a question, not as a finished turn', () => {
    seedSession('s-1', 'interactive')
    sendCaptureDoorbell(db, sender, { userId: 1, strandId: 's-1', agentId: 'bob', messageId: 42 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'question', strandId: 's-1', agentId: 'bob', userId: 1, messageId: 42 })
    // `question` is the one kind that survives suppress-when-online=turn and
    // wakes the device now. A `turn_done` would be dropped with the app open,
    // which is exactly the silence this band exists to end.
    expect(priorityFor(sent[0].kind)).toBe('high')
  })

  it('stays silent for a capture question in a non interactive session', () => {
    seedSession('s-task', 'task')
    sendCaptureDoorbell(db, sender, { userId: 1, strandId: 's-task', agentId: 'bob', messageId: null })
    expect(sent).toHaveLength(0)
  })
})

describe('doorbell content, only when asked for', () => {
  function senderWith(previewChars: number): PushSender {
    return { previewChars, sendDetached: (d: PushDoorbell) => { sent.push(d) } } as unknown as PushSender
  }

  it('carries no excerpt and no strand title by default', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)")
      .run('s-1', 'The roof quote is 25 520 EUR.')
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Roof quotes', 's-1')

    sendTurnDoorbell(db, senderWith(0), { userId: 1, sessionId: 's-1', agentId: 'bob', failed: false })

    expect(sent[0].preview ?? null).toBeNull()
    expect(sent[0].title).toBe('bob')
  })

  it('carries the strand title and the answer text once previews are enabled', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)")
      .run('s-1', 'The roof quote is 25 520 EUR.')
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Roof quotes', 's-1')

    sendTurnDoorbell(db, senderWith(120), { userId: 1, sessionId: 's-1', agentId: 'bob', failed: false })

    expect(sent[0].preview).toBe('The roof quote is 25 520 EUR.')
    expect(sent[0].title).toBe('Roof quotes')
  })

  it('falls back to the persona when the strand has no title', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)").run('s-1', 'Done.')
    sendTurnDoorbell(db, senderWith(120), { userId: 1, sessionId: 's-1', agentId: 'bob', failed: false })
    expect(sent[0].title).toBe('bob')
    expect(sent[0].preview).toBe('Done.')
  })

  it('never quotes a failed turn', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)").run('s-1', 'half an a')
    sendTurnDoorbell(db, senderWith(120), { userId: 1, sessionId: 's-1', agentId: 'bob', failed: true })
    expect(sent[0].kind).toBe('error')
    expect(sent[0].preview ?? null).toBeNull()
  })

  it('a capture question stays a label, previews or not', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)").run('s-1', 'secret')
    sendCaptureDoorbell(db, senderWith(120), { userId: 1, strandId: 's-1', agentId: 'bob', messageId: 1 })
    expect(sent[0].preview ?? null).toBeNull()
    expect(sent[0].title).toBe('bob')
  })

  it('a task doorbell stays a label, previews or not', () => {
    seedSession('s-1', 'interactive')
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)").run('s-1', 'secret')
    sendTaskDoorbell(db, senderWith(120), { userId: 1, sessionId: 's-1', agentId: 'bob', type: 'task_completed' })
    expect(sent[0].preview ?? null).toBeNull()
    expect(sent[0].title).toBe('bob')
  })
})
