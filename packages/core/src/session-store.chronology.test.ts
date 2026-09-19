/**
 * `chat_messages.timestamp` has second resolution. Every read that claims to
 * return the conversation "in order" therefore has to carry `id` as the
 * tiebreaker — otherwise the sliding-window topic detection and the session
 * texts see a shuffled conversation whenever a turn is fast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { getSessionMessageTexts, getSessionMessages } from './session-store.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, started_at) VALUES ('s1', '1', 'web', 'interactive', ?)",
  ).run('2026-09-15 07:35:00')

  const insert = db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, timestamp) VALUES ('s1', 1, ?, ?, ?)",
  )
  // Everything inside one second, the normal case for a quick exchange.
  insert.run('user', 'frage eins', '2026-09-15 07:35:00')
  insert.run('assistant', 'antwort eins', '2026-09-15 07:35:00')
  insert.run('user', 'frage zwei', '2026-09-15 07:35:00')
  insert.run('assistant', 'antwort zwei', '2026-09-15 07:35:00')
  // …and one row in the next second, to prove timestamp still wins over id.
  insert.run('user', 'frage drei', '2026-09-15 07:35:01')
})

afterEach(() => {
  db.close()
})

describe('session texts keep the written order inside one second', () => {
  it('getSessionMessageTexts returns insertion order', () => {
    expect(getSessionMessageTexts(db, 's1')).toEqual([
      'frage eins',
      'antwort eins',
      'frage zwei',
      'antwort zwei',
      'frage drei',
    ])
  })

  it('getSessionMessages returns insertion order', () => {
    expect(getSessionMessages(db, 's1').map(m => m.content)).toEqual([
      'frage eins',
      'antwort eins',
      'frage zwei',
      'antwort zwei',
      'frage drei',
    ])
  })

  it('timestamp still outranks id', () => {
    // A row inserted later but stamped earlier belongs at the front.
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, timestamp) VALUES ('s1', 1, 'user', 'nachtrag von gestern', '2026-09-14 20:00:00')",
    ).run()
    expect(getSessionMessageTexts(db, 's1')[0]).toBe('nachtrag von gestern')
  })

  it('reads the naked UTC timestamp as UTC, not as local time', () => {
    const [first] = getSessionMessages(db, 's1')
    expect(first!.timestampMs).toBe(Date.parse('2026-09-15T07:35:00Z'))
  })
})
