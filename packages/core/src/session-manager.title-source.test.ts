/**
 * Strand title provenance (plan strand-titel, Paket 4): the manual guard.
 *
 * A title the user typed is 'manual' and must never be replaced
 * automatically. These pin down who sets which source:
 *   - createThread: 'derived' by default, the caller can say 'ai'/'manual';
 *   - ensureThreadTitle: writes 'derived', stays write-once, never touches
 *     a manual strand;
 *   - updateThread with a CHANGED title: 'manual', previous_title kept;
 *     an unchanged title is no rename; clearing hands the strand back to the
 *     automatic title (source NULL); pin/archive leave the source alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from './session-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

describe('SessionManager title source', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-title-source-'))
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function manager(): SessionManager {
    return new SessionManager({ db, memoryDir, timeoutMinutes: 15 })
  }

  function raw(id: string): { title: string | null; title_source: string | null; previous_title: string | null; title_updated_at: string | null; auto_title_changes: number } {
    return db.prepare('SELECT title, title_source, previous_title, title_updated_at, auto_title_changes FROM sessions WHERE id = ?').get(id) as never
  }

  describe('createThread', () => {
    it('marks a given title as derived by default and exposes it on the thread', () => {
      const thread = manager().createThread('1', 'main', 'Garden plan')
      expect(thread.titleSource).toBe('derived')
      expect(thread.titleUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(thread.previousTitle).toBeNull()
      expect(raw(thread.id)).toMatchObject({ title_source: 'derived', auto_title_changes: 0 })
    })

    it('takes the source the caller names', () => {
      const sm = manager()
      expect(sm.createThread('1', 'main', 'Router title', null, 'main', 'ai').titleSource).toBe('ai')
      expect(sm.createThread('1', 'main', 'Typed title', null, 'main', 'manual').titleSource).toBe('manual')
    })

    it('leaves source and timestamp empty without a title', () => {
      const thread = manager().createThread('1', 'main', '   ', null, 'main', 'manual')
      expect(thread.title).toBeNull()
      expect(thread.titleSource).toBeNull()
      expect(thread.titleUpdatedAt).toBeNull()
    })
  })

  describe('ensureThreadTitle', () => {
    it('derives a title for an untitled strand and marks it derived', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main')
      sm.ensureThreadTitle(thread.id, 'Wie plane ich den Hausordnung für das Erdgeschoss?')
      const row = raw(thread.id)
      expect(row.title).toBeTruthy()
      expect(row.title_source).toBe('derived')
    })

    it('stays write-once: an existing title of any source is untouched', () => {
      const sm = manager()
      const manual = sm.createThread('1', 'main', 'Mein Name', null, 'main', 'manual')
      const ai = sm.createThread('1', 'main', 'Router title', null, 'main', 'ai')
      sm.ensureThreadTitle(manual.id, 'Something completely different')
      sm.ensureThreadTitle(ai.id, 'Something completely different')
      expect(raw(manual.id)).toMatchObject({ title: 'Mein Name', title_source: 'manual' })
      expect(raw(ai.id)).toMatchObject({ title: 'Router title', title_source: 'ai' })
    })

    it('never touches a strand marked manual, even without a title', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main')
      db.prepare("UPDATE sessions SET title_source = 'manual' WHERE id = ?").run(thread.id)
      sm.ensureThreadTitle(thread.id, 'Derived from the first message')
      expect(raw(thread.id)).toMatchObject({ title: null, title_source: 'manual' })
    })
  })

  describe('updateThread (PATCH)', () => {
    it('marks a renamed title manual and keeps the previous title', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main', 'Wie plane ich')
      const updated = sm.updateThread('1', thread.id, { title: '  Hausordnung EG  ' })
      expect(updated).toMatchObject({ title: 'Hausordnung EG', titleSource: 'manual', previousTitle: 'Wie plane ich' })
      expect(updated!.titleUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(raw(thread.id)).toMatchObject({ title_source: 'manual', previous_title: 'Wie plane ich', auto_title_changes: 0 })
    })

    it('marks an ai title manual once the user renames it', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main', 'Router title', null, 'main', 'ai')
      expect(sm.updateThread('1', thread.id, { title: 'Mine' })).toMatchObject({ titleSource: 'manual', previousTitle: 'Router title' })
    })

    it('treats an unchanged title as no rename', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main', 'Garden plan')
      const before = raw(thread.id)
      const updated = sm.updateThread('1', thread.id, { title: ' Garden plan ', pinned: true })
      expect(updated).toMatchObject({ title: 'Garden plan', titleSource: 'derived', previousTitle: null, pinned: true })
      expect(raw(thread.id)).toEqual(before)
    })

    it('hands the strand back to the automatic title when the title is cleared', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main', 'Mein Name', null, 'main', 'manual')
      const cleared = sm.updateThread('1', thread.id, { title: '' })
      expect(cleared).toMatchObject({ title: null, titleSource: null, previousTitle: 'Mein Name' })
      sm.ensureThreadTitle(thread.id, 'Neues Thema aus der ersten Nachricht')
      expect(raw(thread.id).title_source).toBe('derived')
    })

    it('leaves the source alone on pin and archive', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'main', 'Mein Name', null, 'main', 'manual')
      sm.updateThread('1', thread.id, { pinned: true })
      sm.updateThread('1', thread.id, { archived: true })
      expect(raw(thread.id)).toMatchObject({ title: 'Mein Name', title_source: 'manual', previous_title: null })
    })

    it('lists the source on every thread', () => {
      const sm = manager()
      const a = sm.createThread('1', 'main', 'A')
      sm.updateThread('1', a.id, { title: 'A2' })
      const listed = sm.listThreads('1').find(t => t.id === a.id)
      expect(listed).toMatchObject({ titleSource: 'manual', previousTitle: 'A' })
    })
  })
})
