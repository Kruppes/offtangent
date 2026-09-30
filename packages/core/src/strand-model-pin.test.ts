/**
 * Strand isolation goal 3: every strand carries its own model pin.
 *
 * Without a pin a strand silently follows whatever the global selector says
 * at turn time, which is exactly the bleeding the isolation removes. New
 * strands are pinned at creation time, old ones once by the backfill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { SessionManager } from './session-manager.js'
import { backfillStrandModelPins, resolveBackfillStrandModel } from './strand-model-pin.js'

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'system'),
  appendToDailyFile: vi.fn(),
  resolveAgentMemoryDir: vi.fn(() => undefined),
}))

function pinOf(db: Database, sessionId: string) {
  return db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(sessionId) as
    { model_provider_id: string | null; model_id: string | null }
}

describe('strand model pins', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'tester', 'x', 'user')").run()
  })

  it('pins a new strand at creation time to the resolved default', () => {
    const sm = new SessionManager({
      db,
      resolveDefaultStrandModel: (agentId) => agentId === 'coder'
        ? { providerId: 'anthropic-oauth', modelId: 'claude-sonnet-5' }
        : { providerId: 'openai', modelId: 'gpt-6-astra' },
    })
    const main = sm.createThread('1', 'main', 'Main strand')
    const coder = sm.createThread('1', 'coder', 'Coder strand')

    expect(pinOf(db, main.id)).toEqual({ model_provider_id: 'openai', model_id: 'gpt-6-astra' })
    expect(pinOf(db, coder.id)).toEqual({ model_provider_id: 'anthropic-oauth', model_id: 'claude-sonnet-5' })
  })

  it('pins a strand that a plain chat turn opens, not just an explicitly created one', () => {
    const sm = new SessionManager({
      db,
      resolveDefaultStrandModel: () => ({ providerId: 'openai', modelId: 'gpt-6-astra' }),
    })
    const session = sm.getOrCreateSession('1', 'web', 'main')
    expect(pinOf(db, session.id)).toEqual({ model_provider_id: 'openai', model_id: 'gpt-6-astra' })
  })

  it('leaves a strand unpinned when no default resolves, and never throws', () => {
    const sm = new SessionManager({
      db,
      resolveDefaultStrandModel: () => null,
    })
    const strand = sm.createThread('1', 'main', 'No default')
    expect(pinOf(db, strand.id)).toEqual({ model_provider_id: null, model_id: null })

    const throwing = new SessionManager({
      db,
      resolveDefaultStrandModel: () => { throw new Error('providers.json unreadable') },
    })
    const survived = throwing.createThread('1', 'main', 'Resolver exploded')
    expect(pinOf(db, survived.id)).toEqual({ model_provider_id: null, model_id: null })
  })

  it('does not pin non-interactive sessions (tasks resolve their model per call)', () => {
    const sm = new SessionManager({
      db,
      resolveDefaultStrandModel: () => ({ providerId: 'openai', modelId: 'gpt-6-astra' }),
    })
    const task = sm.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'main' })
    expect(pinOf(db, task.id)).toEqual({ model_provider_id: null, model_id: null })
  })

  describe('backfill', () => {
    /** Insert a strand the way it looked before pin-on-create existed. */
    function legacyStrand(id: string, agentId = 'main') {
      db.prepare(
        `INSERT INTO sessions (id, source, type, started_at, last_activity, session_user, message_count, summary_written, agent_id)
         VALUES (?, 'web', 'interactive', datetime('now'), datetime('now'), '1', 3, 0, ?)`
      ).run(id, agentId)
      return id
    }

    it('pins every unpinned interactive strand to the persona default and is idempotent', () => {
      legacyStrand('legacy-main')
      legacyStrand('legacy-coder', 'coder')
      db.prepare(
        `INSERT INTO sessions (id, source, type, started_at, last_activity, session_user, message_count, summary_written, agent_id, model_provider_id, model_id)
         VALUES ('already', 'web', 'interactive', datetime('now'), datetime('now'), '1', 1, 0, 'main', 'chosen', 'chosen-model')`
      ).run()
      db.prepare(
        `INSERT INTO sessions (id, source, type, started_at, last_activity, session_user, message_count, summary_written, agent_id)
         VALUES ('a-task', 'task', 'task', datetime('now'), datetime('now'), '1', 1, 0, 'main')`
      ).run()

      const resolve = (agentId: string) => agentId === 'coder'
        ? { providerId: 'anthropic-oauth', modelId: 'claude-sonnet-5' }
        : { providerId: 'openai', modelId: 'gpt-6-astra' }

      const first = backfillStrandModelPins(db, resolve)
      expect(first).toMatchObject({ ran: true, candidates: 2, pinned: 2, skipped: 0 })
      expect(pinOf(db, 'legacy-main')).toEqual({ model_provider_id: 'openai', model_id: 'gpt-6-astra' })
      expect(pinOf(db, 'legacy-coder')).toEqual({ model_provider_id: 'anthropic-oauth', model_id: 'claude-sonnet-5' })
      // An existing user choice is never overwritten.
      expect(pinOf(db, 'already')).toEqual({ model_provider_id: 'chosen', model_id: 'chosen-model' })
      // Task sessions are out of scope.
      expect(pinOf(db, 'a-task')).toEqual({ model_provider_id: null, model_id: null })

      // Second run: marker short-circuits, nothing is touched.
      const second = backfillStrandModelPins(db, resolve)
      expect(second).toMatchObject({ ran: false, pinned: 0 })

      // Even forced, an existing pin survives (the UPDATE is NULL-guarded).
      db.prepare("UPDATE sessions SET model_provider_id = 'user-choice', model_id = 'user-model' WHERE id = 'legacy-main'").run()
      backfillStrandModelPins(db, resolve, { force: true })
      expect(pinOf(db, 'legacy-main')).toEqual({ model_provider_id: 'user-choice', model_id: 'user-model' })
    })

    it('skips personas whose default cannot be resolved instead of guessing', () => {
      legacyStrand('keeps-null', 'ghost')
      legacyStrand('gets-pinned', 'main')
      const result = backfillStrandModelPins(db, (agentId) =>
        agentId === 'main' ? { providerId: 'openai', modelId: 'gpt-6-astra' } : null)

      expect(result).toMatchObject({ candidates: 2, pinned: 1, skipped: 1, unresolvedAgents: ['ghost'] })
      expect(pinOf(db, 'keeps-null')).toEqual({ model_provider_id: null, model_id: null })
      expect(pinOf(db, 'gets-pinned')).toEqual({ model_provider_id: 'openai', model_id: 'gpt-6-astra' })
    })

    it('reports what it would do without writing in dry-run mode', () => {
      legacyStrand('dry')
      const result = backfillStrandModelPins(db, () => ({ providerId: 'openai', modelId: 'gpt-6-astra' }), { dryRun: true })
      expect(result).toMatchObject({ candidates: 1, pinned: 1, ran: true })
      expect(pinOf(db, 'dry')).toEqual({ model_provider_id: null, model_id: null })
    })
  })
  describe('backfill target resolution', () => {
    const configured = { providerId: 'provider-b', modelId: 'model-b' }
    const resolveSpec = (spec: string) =>
      spec === 'provider-b:model-b' ? configured : null

    it('prefers the persona pin over the configured backfill default', () => {
      const result = resolveBackfillStrandModel({
        personaPin: { providerId: 'provider-a', modelId: 'model-a' },
        configuredSpec: 'provider-b:model-b',
        globalDefault: { providerId: 'provider-c', modelId: 'model-c' },
        resolveSpec,
      })
      expect(result).toEqual({ pin: { providerId: 'provider-a', modelId: 'model-a' }, source: 'persona' })
    })

    it('uses the configured backfill default when the persona has no pin', () => {
      const result = resolveBackfillStrandModel({
        personaPin: null,
        configuredSpec: 'provider-b:model-b',
        globalDefault: { providerId: 'provider-c', modelId: 'model-c' },
        resolveSpec,
      })
      expect(result).toEqual({ pin: configured, source: 'configured' })
    })

    it('falls back to the global default when nothing is configured', () => {
      const result = resolveBackfillStrandModel({
        personaPin: null,
        configuredSpec: null,
        globalDefault: { providerId: 'provider-c', modelId: 'model-c' },
        resolveSpec,
      })
      expect(result).toEqual({ pin: { providerId: 'provider-c', modelId: 'model-c' }, source: 'global' })
    })

    it('warns and falls back instead of crashing when the configured model does not resolve', () => {
      const warned: string[] = []
      const result = resolveBackfillStrandModel({
        personaPin: null,
        configuredSpec: 'provider-gone:model-gone',
        globalDefault: { providerId: 'provider-c', modelId: 'model-c' },
        resolveSpec,
        onUnresolvedSpec: spec => warned.push(spec),
      })
      expect(result).toEqual({ pin: { providerId: 'provider-c', modelId: 'model-c' }, source: 'global' })
      expect(warned).toEqual(['provider-gone:model-gone'])
    })

    it('survives a resolver that throws and reports no pin when every source is empty', () => {
      const result = resolveBackfillStrandModel({
        personaPin: null,
        configuredSpec: 'provider-b:model-b',
        globalDefault: null,
        resolveSpec: () => { throw new Error('providers.json unreadable') },
      })
      expect(result).toEqual({ pin: null, source: 'none' })
    })
  })
})
