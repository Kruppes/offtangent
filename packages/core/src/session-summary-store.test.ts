import { describe, expect, it, beforeEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { getLatestSessionSummary, insertSessionSummary, listSessionSummaries } from './session-summary-store.js'

describe('session_summaries store', () => {
  let db: Database
  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('creates the table on init and versions rows per session', () => {
    expect(getLatestSessionSummary(db, 's1')).toBeNull()
    const v1 = insertSessionSummary(db, 's1', { goal: 'G', decisions: ['a'], open: [], artifacts: [], next: [] }, { goal: 'G' }, 'm')
    const v2 = insertSessionSummary(db, 's1', { goal: 'G', decisions: ['a', 'b'], open: [], artifacts: [], next: [] }, { add: { decisions: ['b'] } }, 'm')
    insertSessionSummary(db, 's2', { goal: 'other', decisions: [], open: [], artifacts: [], next: [] }, null, null)
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    const latest = getLatestSessionSummary(db, 's1')
    expect(latest?.version).toBe(2)
    expect(latest?.summary.decisions).toEqual(['a', 'b'])
    expect(latest?.delta).toEqual({ add: { decisions: ['b'] } })
    expect(latest?.model).toBe('m')
    expect(listSessionSummaries(db, 's1').map(r => r.version)).toEqual([1, 2])
  })

  it('is idempotent across a second initDatabase on the same connection schema', () => {
    const cols = db.prepare("PRAGMA table_info(session_summaries)").all() as { name: string }[]
    expect(cols.map(c => c.name)).toEqual(['id', 'session_id', 'version', 'schema_json', 'delta_json', 'model', 'created_at'])
  })
})
