import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { ensureOfftangentTables } from './offtangent-schema.js'
import {
  NOW_SET_MAX,
  addStrandTags,
  addToNowSetIfRoom,
  createTag,
  getCurrentDecision,
  getNowRank,
  getNowSet,
  insertCapture,
  insertDecision,
  isNowSetTooLargeError,
  listCaptures,
  listTags,
  normalizeTagName,
  removeFromNowSet,
  setNowSet,
  setStrandTags,
  strandIdsWithTag,
  updateCapture,
  updateDecision,
  updateTag,
} from './strand-store.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('schema', () => {
  it('creates the Offtangent tables and the capture_id column idempotently', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name)
    for (const t of ['captures', 'router_decisions', 'tags', 'strand_tags', 'strand_links', 'now_set', 'resurface_snoozes']) {
      expect(names).toContain(t)
    }
    const cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('capture_id')
    const decisionCols = (db.prepare('PRAGMA table_info(router_decisions)').all() as { name: string }[]).map(c => c.name)
    expect(decisionCols).toContain('new_strand_project')
    expect(decisionCols).toContain('project_suggestion')
  })

  it('adds the project columns to an existing router_decisions table (live database path)', () => {
    // Exactly the shape the deployed database has: the table exists without the
    // SPEC 4.2b columns, so only the ALTER path can add them.
    db.exec('DROP TABLE router_decisions')
    db.exec(`CREATE TABLE router_decisions (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('append','new_strand','link')),
      target_strand_id TEXT,
      secondary_strand_id TEXT,
      created_strand_id TEXT,
      intent TEXT NOT NULL DEFAULT 'ask' CHECK(intent IN ('note','ask')),
      confidence REAL NOT NULL,
      alternatives TEXT,
      tags TEXT,
      rationale TEXT,
      new_strand_title TEXT,
      new_strand_persona TEXT,
      model TEXT,
      latency_ms INTEGER,
      state TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      applied_at TEXT,
      resolved_at TEXT
    )`)
    db.prepare(
      `INSERT INTO router_decisions (id, capture_id, action, confidence, state) VALUES ('old', 'cap', 'append', 0.9, 'applied')`,
    ).run()

    ensureOfftangentTables(db)
    ensureOfftangentTables(db)

    const cols = (db.prepare('PRAGMA table_info(router_decisions)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('new_strand_project')
    expect(cols).toContain('project_suggestion')
    const old = getCurrentDecision(db, 'cap')
    expect(old?.projectId).toBeNull()
    expect(old?.projectSuggestion).toBeNull()
  })
})

describe('tags', () => {
  it('normalizes names to slugs and is idempotent per user', () => {
    expect(normalizeTagName('  Haus Dach ')).toBe('haus-dach')
    expect(normalizeTagName('###')).toBeNull()
    expect(normalizeTagName('x'.repeat(50))?.length).toBe(40)
    const a = createTag(db, 'u1', { name: 'Haus', color: '#FF0000' })
    const b = createTag(db, 'u1', { name: 'haus' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.tag.id).toBe(a.tag.id)
    expect(a.tag.color).toBe('#ff0000')
    expect(createTag(db, 'u2', { name: 'haus' }).created).toBe(true)
    expect(() => createTag(db, 'u1', { name: 'x', color: 'red' })).toThrow()
  })

  it('sets and adds strand tags and filters strands by tag', () => {
    expect(setStrandTags(db, 'u1', 's1', ['B', 'a', 'a'])).toEqual(['a', 'b'])
    expect(addStrandTags(db, 'u1', 's1', ['c'], 'router')).toEqual(['a', 'b', 'c'])
    expect(setStrandTags(db, 'u1', 's1', ['c'])).toEqual(['c'])
    expect(strandIdsWithTag(db, 'u1', 'c')).toEqual(['s1'])
    expect(strandIdsWithTag(db, 'u2', 'c')).toEqual([])
    const tag = listTags(db, 'u1').find(t => t.name === 'c')!
    expect(updateTag(db, 'u1', tag.id, { archived: true })?.archived).toBe(true)
    expect(listTags(db, 'u1').map(t => t.name)).toEqual(['a', 'b'])
    expect(listTags(db, 'u1', { includeArchived: true }).map(t => t.name)).toEqual(['a', 'b', 'c'])
    expect(updateTag(db, 'u2', tag.id, { name: 'z' })).toBeNull()
  })
})

describe('now set', () => {
  it('holds at most four strands, ordered by rank', () => {
    expect(setNowSet(db, 'u1', ['a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(getNowRank(db, 'u1', 'b')).toBe(2)
    expect(getNowRank(db, 'u2', 'b')).toBeNull()
    let err: unknown
    try {
      setNowSet(db, 'u1', ['a', 'b', 'c', 'd', 'e'])
    } catch (e) {
      err = e
    }
    expect(isNowSetTooLargeError(err)).toBe(true)
    expect(getNowSet(db, 'u1')).toEqual(['a', 'b'])
    expect(addToNowSetIfRoom(db, 'u1', 'c')).toBe(true)
    expect(addToNowSetIfRoom(db, 'u1', 'c')).toBe(false)
    expect(addToNowSetIfRoom(db, 'u1', 'd')).toBe(true)
    expect(getNowSet(db, 'u1').length).toBe(NOW_SET_MAX)
    expect(addToNowSetIfRoom(db, 'u1', 'e')).toBe(false)
  })

  it('takes the size as a parameter and names it in the error', () => {
    expect(setNowSet(db, 'u1', ['a', 'b', 'c', 'd', 'e', 'f'], 6)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    let err: unknown
    try {
      setNowSet(db, 'u1', ['a', 'b', 'c'], 2)
    } catch (e) {
      err = e
    }
    expect(isNowSetTooLargeError(err)).toBe(true)
    expect((err as Error).message).toBe('The now set holds at most 2 strands')
    expect(getNowSet(db, 'u1').length).toBe(6)
  })

  it('keeps a set that is over a lowered limit and only refuses further additions', () => {
    setNowSet(db, 'u1', ['a', 'b', 'c', 'd', 'e', 'f'], 6)

    // The size setting drops to 4 while six strands are in the set.
    expect(getNowSet(db, 'u1')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(addToNowSetIfRoom(db, 'u1', 'g', 4)).toBe(false)
    expect(getNowSet(db, 'u1')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])

    // Removing stays possible even while the set is over the limit.
    expect(removeFromNowSet(db, 'u1', 'c')).toBe(true)
    expect(getNowSet(db, 'u1')).toEqual(['a', 'b', 'd', 'e', 'f'])
    expect(getNowRank(db, 'u1', 'f')).toBe(5)
    expect(addToNowSetIfRoom(db, 'u1', 'g', 4)).toBe(false)

    // Once the set fits again, additions work without any further change.
    removeFromNowSet(db, 'u1', 'a')
    removeFromNowSet(db, 'u1', 'b')
    expect(getNowSet(db, 'u1')).toEqual(['d', 'e', 'f'])
    expect(addToNowSetIfRoom(db, 'u1', 'g', 4)).toBe(true)
    expect(getNowSet(db, 'u1')).toEqual(['d', 'e', 'f', 'g'])
  })
})

describe('captures and decisions', () => {
  it('stores captures per user with the newest decision as the current one', () => {
    const capture = insertCapture(db, {
      userId: 'u1', agentId: null, clientMessageId: 'c1', text: 'hello', kind: 'text', source: 'web', attachments: [],
    })
    expect(capture.status).toBe('pending')
    expect(listCaptures(db, 'u2').length).toBe(0)
    const first = insertDecision(db, {
      captureId: capture.id, action: 'append', strandId: 's1', secondaryStrandId: null, intent: 'note',
      confidence: 0.8, tags: ['x'], rationale: 'r', alternatives: [], model: 'm', latencyMs: 10, state: 'applied',
    })
    expect(first.appliedAt).not.toBeNull()
    updateDecision(db, first.id, { state: 'undone', resolvedAt: 'now' })
    const second = insertDecision(db, {
      captureId: capture.id, action: 'new_strand', strandId: null, secondaryStrandId: null, intent: 'note',
      confidence: 1, tags: [], rationale: 'user', alternatives: [], model: 'user', latencyMs: null, state: 'applied',
    })
    expect(getCurrentDecision(db, capture.id)?.id).toBe(second.id)
    expect(first.projectId).toBeNull()
    expect(first.projectSuggestion).toBeNull()

    // SPEC 4.2b: the created strand project and the suggestion round trip.
    const third = insertDecision(db, {
      captureId: capture.id, action: 'append', strandId: 's1', secondaryStrandId: null, intent: 'note',
      confidence: 0.9, tags: [], rationale: 'r', alternatives: [], model: 'm', latencyMs: 1, state: 'applied',
      projectId: 'prj_1', projectSuggestion: { projectId: 'prj_2', confidence: 0.66, reason: 'fits the house' },
    })
    expect(third.projectId).toBe('prj_1')
    expect(third.projectSuggestion).toEqual({ projectId: 'prj_2', confidence: 0.66, reason: 'fits the house' })
    expect(getCurrentDecision(db, capture.id)?.projectSuggestion?.confidence).toBe(0.66)
    updateCapture(db, capture.id, { status: 'filed', strandId: 's1', messageId: 5, filedAt: 'now' })
    const filed = listCaptures(db, 'u1', { status: 'filed' })[0]
    expect(filed.strandId).toBe('s1')
    expect(filed.messageId).toBe(5)
    expect(filed.filedAt).not.toBeNull()
  })
})
