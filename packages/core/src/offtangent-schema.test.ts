import { expect, it } from 'vitest'
import { initDatabase } from './database.js'
import { ensureOfftangentTables } from './offtangent-schema.js'

it('adds nullable capture metadata to existing databases idempotently without changing old captures', () => {
  const db = initDatabase(':memory:')
  try {
    db.exec('ALTER TABLE captures DROP COLUMN metadata')
    db.prepare('INSERT INTO captures (id, user_id, text) VALUES (?, ?, ?)').run('old-capture', '1', 'Old note')
    ensureOfftangentTables(db)
    ensureOfftangentTables(db)
    expect(db.prepare('SELECT id, text, metadata FROM captures').get()).toEqual({
      id: 'old-capture', text: 'Old note', metadata: null,
    })
  } finally {
    db.close()
  }
})
