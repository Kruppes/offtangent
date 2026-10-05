import { describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import { inheritEcoMode, isStrandEcoEnabled, readStrandContextWindow, setStrandContextWindow, setStrandEcoEnabled } from './eco-mode-store.js'

/* Synthetic only: in-memory DB, no network, no model. */
function setup() {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'a', 'x', 'admin'), (2, 'b', 'x', 'user')").run()
  for (const [id, user] of [['s-a', 1], ['s-b', 1], ['s-other', 2], ['child', 1]] as const) {
    db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, user)
  }
  return db
}

describe('per-strand Eco context window', () => {
  it('defaults to null (Unverändert) and is independent of the Eco switch', () => {
    const db = setup()
    expect(readStrandContextWindow(db, 's-a')).toBeNull()
    expect(setStrandContextWindow(db, 's-a', 65536)).toBe(true)
    expect(isStrandEcoEnabled(db, 's-a')).toBe(false)
    setStrandEcoEnabled(db, 's-a', true)
    setStrandEcoEnabled(db, 's-a', false)
    expect(readStrandContextWindow(db, 's-a')).toBe(65536)
    expect(setStrandContextWindow(db, 's-a', null)).toBe(true)
    expect(readStrandContextWindow(db, 's-a')).toBeNull()
  })

  it('isolates strands and users: writing one never touches another', () => {
    const db = setup()
    setStrandContextWindow(db, 's-a', 131072)
    setStrandContextWindow(db, 's-other', 32768)
    expect(readStrandContextWindow(db, 's-b')).toBeNull()
    expect(readStrandContextWindow(db, 's-a')).toBe(131072)
    expect(readStrandContextWindow(db, 's-other')).toBe(32768)
  })

  it('refuses invalid values at the store and never returns a corrupt persisted value', () => {
    const db = setup()
    for (const bad of [800000000, 0, -1, 1.5, 12345]) {
      expect(() => setStrandContextWindow(db, 's-a', bad)).toThrow()
    }
    db.prepare('UPDATE sessions SET eco_context_window = 800000000 WHERE id = ?').run('s-a')
    expect(readStrandContextWindow(db, 's-a')).toBeNull()
    expect(readStrandContextWindow(db, null)).toBeNull()
    expect(readStrandContextWindow(db, 'missing')).toBeNull()
  })

  it('task inherit snapshots the parent choice at start; later parent changes do not leak', () => {
    const db = setup()
    setStrandContextWindow(db, 's-a', 49152)
    inheritEcoMode(db, 's-a', 'child')
    expect(readStrandContextWindow(db, 'child')).toBe(49152)
    expect(isStrandEcoEnabled(db, 'child')).toBe(false)
    setStrandContextWindow(db, 's-a', 131072)
    expect(readStrandContextWindow(db, 'child')).toBe(49152) // resume reads the child's own snapshot
  })

  it('task inherit with no parent choice writes nothing', () => {
    const db = setup()
    inheritEcoMode(db, 's-b', 'child')
    inheritEcoMode(db, null, 'child')
    expect(readStrandContextWindow(db, 'child')).toBeNull()
  })
})
