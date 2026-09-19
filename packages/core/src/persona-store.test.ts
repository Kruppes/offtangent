/**
 * The persona record and the `is_default` flag (SPEC 13.2, 13.5).
 *
 * The migration has to be boring: it must run twice without complaining, it
 * must not change what an existing install answers, and it must leave exactly
 * one default persona behind at all times.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  ensurePersonaTable,
  ensurePersonaRecord,
  getPersonaRecord,
  listPersonaRecords,
  updatePersonaRecord,
  deletePersonaRecord,
  getDefaultPersonaId,
  hasLiveTaskForPersona,
  previewPersonaDelete,
} from './persona-store.js'

let db: Database

beforeEach(() => { db = initDatabase(':memory:') })
afterEach(() => { db.close() })

describe('ensurePersonaTable', () => {
  it('is idempotent', () => {
    expect(() => { ensurePersonaTable(db); ensurePersonaTable(db) }).not.toThrow()
    const flagged = db.prepare('SELECT COUNT(*) AS c FROM personas WHERE is_default = 1').get() as { c: number }
    expect(flagged.c).toBe(1)
  })

  it('seeds the historical default so an upgrade answers as before', () => {
    expect(getDefaultPersonaId(db)).toBe('main')
  })

  it('does not steal the flag from an install that already moved it', () => {
    updatePersonaRecord(db, 'gekko', { isDefault: true })
    ensurePersonaTable(db)
    expect(getDefaultPersonaId(db)).toBe('gekko')
  })

  it('enforces one default at the database level', () => {
    ensurePersonaRecord(db, 'bob')
    expect(() => db.prepare('UPDATE personas SET is_default = 1 WHERE id = ?').run('bob')).toThrow()
  })
})

describe('the record', () => {
  it('stores colour, badge and display name', () => {
    const record = updatePersonaRecord(db, 'scout', {
      displayName: 'Scout', color: '#4f8ef7', badge: '🧭',
    })
    expect(record).toMatchObject({ id: 'scout', displayName: 'Scout', color: '#4f8ef7', badge: '🧭', archived: false, isDefault: false })
    expect(getPersonaRecord(db, 'scout')?.displayName).toBe('Scout')
  })

  it('archives and restores without touching anything else', () => {
    updatePersonaRecord(db, 'scout', { displayName: 'Scout' })
    expect(updatePersonaRecord(db, 'scout', { archived: true }).archived).toBe(true)
    const restored = updatePersonaRecord(db, 'scout', { archived: false })
    expect(restored.archived).toBe(false)
    expect(restored.displayName).toBe('Scout')
  })

  it('moves the default flag atomically and un-archives the new default', () => {
    updatePersonaRecord(db, 'scout', { archived: true })
    updatePersonaRecord(db, 'scout', { isDefault: true })
    expect(getDefaultPersonaId(db)).toBe('scout')
    expect(getPersonaRecord(db, 'scout')?.archived).toBe(false)
    expect(getPersonaRecord(db, 'main')?.isDefault).toBe(false)
    expect(listPersonaRecords(db).filter(r => r.isDefault)).toHaveLength(1)
  })

  it('forgets a deleted persona', () => {
    ensurePersonaRecord(db, 'scout')
    deletePersonaRecord(db, 'scout')
    expect(getPersonaRecord(db, 'scout')).toBeNull()
  })

  it('never clobbers an existing record on ensure', () => {
    updatePersonaRecord(db, 'scout', { displayName: 'Scout' })
    expect(ensurePersonaRecord(db, 'scout').displayName).toBe('Scout')
  })
})

describe('runtime hazard and cascade', () => {
  it('sees a running or paused task of a persona', () => {
    const insert = (id: string, status: string): void => {
      db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, agent_id) VALUES (?, 'n', 'p', ?, 'user', 'scout')")
        .run(id, status)
    }
    expect(hasLiveTaskForPersona(db, 'scout')).toBe(false)
    insert('t1', 'completed')
    expect(hasLiveTaskForPersona(db, 'scout')).toBe(false)
    insert('t2', 'running')
    expect(hasLiveTaskForPersona(db, 'scout')).toBe(true)
    db.prepare("UPDATE tasks SET status = 'paused' WHERE id = 't2'").run()
    expect(hasLiveTaskForPersona(db, 'scout')).toBe(true)
    // A task of a different persona must not block this one.
    expect(hasLiveTaskForPersona(db, 'bob')).toBe(false)
  })

  it('counts what a hard delete would remove', () => {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u', 'x', 'user')").run()
    db.prepare("INSERT INTO sessions (id, session_user, type, agent_id, source) VALUES ('s1', '1', 'interactive', 'scout', 'web')").run()
    db.prepare("INSERT INTO sessions (id, session_user, type, agent_id, source) VALUES ('s2', '1', 'task', 'scout', 'web')").run()
    db.prepare("INSERT INTO chat_messages (user_id, session_id, role, content, agent_id) VALUES (1, 's1', 'user', 'hi', 'scout')").run()
    db.prepare("INSERT INTO memories (user_id, content, agent_id) VALUES (1, 'fact', 'scout')").run()

    const preview = previewPersonaDelete(db, 'scout')
    // Only interactive sessions are strands.
    expect(preview).toMatchObject({ personaId: 'scout', strands: 1, messages: 1, facts: 1, tasks: 0, cronjobs: 0 })
  })
})
