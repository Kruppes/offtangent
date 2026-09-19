import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { insertSessionSummary } from './session-summary-store.js'
import { buildDelegationContext, briefTooThin } from './delegation-context.js'

describe('delegation-context', () => {
  let db: Database
  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'h')").run()
    db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES ('s', 1, 'web', 'interactive')").run()
    const ins = db.prepare("INSERT INTO chat_messages (id, session_id, user_id, role, content) VALUES (?, 's', 1, ?, ?)")
    for (let i = 1; i <= 8; i++) ins.run(i, i % 2 ? 'user' : 'assistant', `message ${i} ` + 'x'.repeat(100))
    insertSessionSummary(db, 's', { goal: 'G', decisions: ['D'], open: [], artifacts: [], next: [] }, null, null)
  })
  afterEach(() => db.close())

  it('clean passes nothing, and any mode without a parent strand is clean', () => {
    expect(buildDelegationContext({ db, mode: 'clean', parentSessionId: 's' }).block).toBeNull()
    const r = buildDelegationContext({ db, mode: 'fork', parentSessionId: null })
    expect(r.block).toBeNull()
    expect(r.mode).toBe('clean')
  })

  it('selected caps message ids at ten and drops unknown ids', () => {
    const r = buildDelegationContext({ db, mode: 'selected', parentSessionId: 's', selection: { strandSummary: true, messageIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } })
    expect(r.block).toContain('<strand_summary>')
    expect(r.block).toContain('[msg:8] Assistant')
    expect(r.droppedMessageIds).toEqual(expect.arrayContaining([11, 12, 9, 10]))
  })

  it('fork keeps the newest rows under the budget and indexes the rest', () => {
    const r = buildDelegationContext({ db, mode: 'fork', parentSessionId: 's', budgetTokens: 420 })
    expect(r.block).toContain('<strand_window>')
    expect(r.block).toContain('[msg:8] Assistant')
    expect(r.block).not.toContain('[msg:1] User')
    expect(r.block).toContain('<earlier_messages>')
    expect(r.block).toMatch(/\[msg:1\] user, \d+ chars/)
  })

  it('briefTooThin honours mode and selection', () => {
    expect(briefTooThin('short', 'clean', undefined, 200)).toBe(true)
    expect(briefTooThin('short', 'fork', undefined, 200)).toBe(false)
    expect(briefTooThin('short', 'selected', { messageIds: [1] }, 200)).toBe(false)
    expect(briefTooThin('short', 'selected', {}, 200)).toBe(true)
    expect(briefTooThin('short', 'clean', undefined, 0)).toBe(false)
    expect(briefTooThin('x'.repeat(200), 'clean', undefined, 200)).toBe(false)
  })
})
