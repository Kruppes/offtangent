/**
 * Forking a strand (`fork_strand`): lineage, nesting, the limits and the two
 * halves of the visible pointer.
 *
 * What these pin down (each fails without strand-fork.ts):
 *   - the new strand starts with the SEED, never with the parent transcript —
 *     that is the entire reason the feature exists;
 *   - the lineage is persisted on the child and the parent keeps a readable
 *     row naming the child, so the jump works in both directions;
 *   - a fork of a fork of a fork works (tree), and the depth limit stops it
 *     before it becomes a chain nobody can read;
 *   - ownership is taken from the strand, never from an argument: a foreign
 *     strand id is simply "not found";
 *   - the per-run budget and the auto-run cascade brake.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { SessionManager } from './session-manager.js'
import { insertSessionSummary } from './session-summary-store.js'
import {
  ForkBudget,
  ForkStrandError,
  MAX_FORKS_PER_TURN,
  MAX_FORK_DEPTH,
  forkDepthOf,
  forkStrand,
  getStrandForkLineage,
  isForkStartedRun,
  listChildStrandIds,
} from './strand-fork.js'

describe('forkStrand', () => {
  let db: Database
  let tmpDir: string
  let sessions: SessionManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-fork-'))
    const memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'x')
    sessions = new SessionManager({ db, memoryDir, timeoutMinutes: 15 })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function parentStrand(userId = 1, title = 'Gmail integration'): string {
    const thread = sessions.createThread(String(userId), 'main', title)
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, 'user', ?, 'main')",
    ).run(thread.id, userId, 'Wir brauchen die Gmail-Integration.')
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, 'assistant', ?, 'main')",
    ).run(thread.id, userId, 'Gerne, ich schaue mir die Scopes an.')
    return thread.id
  }

  function messagesOf(strandId: string): { role: string; content: string; metadata: string | null }[] {
    return db.prepare(
      'SELECT role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id ASC',
    ).all(strandId) as { role: string; content: string; metadata: string | null }[]
  }

  it('starts the new strand with the seed and never with the parent transcript', () => {
    const parent = parentStrand()
    const fork = forkStrand({
      db,
      sessions,
      userId: 1,
      parentStrandId: parent,
      title: 'Privacy: Gmail-Scopes',
      seed: 'Offen: welche Scopes wir lesen dürfen und was gespeichert wird.',
    })

    const rows = messagesOf(fork.strandId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('user')
    expect(rows[0]!.content).toContain('Offen: welche Scopes wir lesen dürfen')
    // The origin is named, the parent transcript is not copied.
    expect(rows[0]!.content).toContain('Gmail integration')
    expect(rows[0]!.content).not.toContain('Gerne, ich schaue mir die Scopes an.')
    expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({
      type: 'strand_fork_seed',
      parentStrandId: parent,
    })
  })

  it('persists the lineage on the child and a readable pointer in the parent', () => {
    const parent = parentStrand()
    const lastParentMessageId = (db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ?')
      .get(parent) as { id: number }).id

    const fork = forkStrand({
      db, sessions, userId: 1, parentStrandId: parent,
      title: 'Privacy: Gmail-Scopes',
      seed: 'Datenschutz-Nebenpfad, eigene Fragen.',
    })

    expect(getStrandForkLineage(db, fork.strandId)).toEqual({
      parentStrandId: parent,
      forkedAt: fork.forkedAt,
      forkedFromMessageId: lastParentMessageId,
    })
    expect(fork.depth).toBe(1)
    expect(listChildStrandIds(db, parent)).toEqual([fork.strandId])

    const notice = messagesOf(parent).at(-1)!
    expect(notice.role).toBe('system')
    expect(notice.content).toContain('Abgezweigt nach: "Privacy: Gmail-Scopes"')
    expect(notice.content).toContain(fork.strandId)
    expect(JSON.parse(notice.metadata!)).toMatchObject({
      type: 'strand_forked',
      childStrandId: fork.strandId,
      childTitle: 'Privacy: Gmail-Scopes',
      autoRun: false,
    })

    // The fork also shows up as a link, so the existing `links` count sees it.
    const link = db.prepare('SELECT from_strand, to_strand, kind FROM strand_links WHERE id = ?')
      .get(fork.linkId) as { from_strand: string; to_strand: string; kind: string }
    expect(link).toEqual({ from_strand: parent, to_strand: fork.strandId, kind: 'reference' })
  })

  it('writes an English pointer for an English seed', () => {
    const parent = parentStrand(1, 'Gmail integration')
    const fork = forkStrand({
      db, sessions, userId: 1, parentStrandId: parent,
      title: 'Privacy: Gmail scopes',
      seed: 'The privacy side path has its own open questions about stored message bodies.',
    })
    expect(messagesOf(parent).at(-1)!.content).toContain('Forked into: "Privacy: Gmail scopes"')
    expect(messagesOf(fork.strandId)[0]!.content).toContain('Forked from the strand "Gmail integration"')
  })

  it('keeps the persona, the project and the model pin of the parent', () => {
    const project = db.prepare(
      "INSERT INTO projects (id, user_id, name) VALUES ('p1', '1', 'Offtangent') RETURNING id",
    ).get() as { id: string }
    const thread = sessions.createThread('1', 'coder', 'Gmail integration', project.id)
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?')
      .run('anthropic', 'claude-test-1', thread.id)

    const fork = forkStrand({
      db, sessions, userId: 1, parentStrandId: thread.id,
      title: 'Privacy',
      seed: 'Nebenpfad Datenschutz.',
    })

    const row = db.prepare('SELECT agent_id, project_id, model_provider_id, model_id FROM sessions WHERE id = ?')
      .get(fork.strandId) as { agent_id: string; project_id: string; model_provider_id: string; model_id: string }
    expect(row).toEqual({
      agent_id: 'coder',
      project_id: 'p1',
      model_provider_id: 'anthropic',
      model_id: 'claude-test-1',
    })
    expect(fork.agentId).toBe('coder')
  })

  it('detaches the project when inherit_project is false', () => {
    db.prepare("INSERT INTO projects (id, user_id, name) VALUES ('p1', '1', 'Offtangent')").run()
    const thread = sessions.createThread('1', 'main', 'Gmail integration', 'p1')
    const fork = forkStrand({
      db, sessions, userId: 1, parentStrandId: thread.id,
      title: 'Privacy', seed: 'Nebenpfad.', inheritProject: false,
    })
    const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(fork.strandId) as { project_id: string | null }
    expect(row.project_id).toBeNull()
  })

  it('appends the parent summary only when asked for it', () => {
    const parent = parentStrand()
    insertSessionSummary(db, parent, {
      goal: 'Gmail anbinden',
      decisions: ['OAuth statt App-Passwort'],
      open: ['Scopes'],
      artifacts: [],
      next: ['Scopes klären'],
    }, null, null)

    const without = forkStrand({
      db, sessions, userId: 1, parentStrandId: parent, title: 'A', seed: 'Nebenpfad eins.',
    })
    expect(messagesOf(without.strandId)[0]!.content).not.toContain('OAuth statt App-Passwort')

    const withSummary = forkStrand({
      db, sessions, userId: 1, parentStrandId: parent, title: 'B', seed: 'Nebenpfad zwei.',
      includeParentSummary: true,
    })
    const seedRow = messagesOf(withSummary.strandId)[0]!.content
    expect(seedRow).toContain('Zusammenfassung des Ursprungs-Strands:')
    expect(seedRow).toContain('OAuth statt App-Passwort')
  })

  it('writes no seed row when the turn will write it (autoRun)', () => {
    const parent = parentStrand()
    const fork = forkStrand({
      db, sessions, userId: 1, parentStrandId: parent, title: 'Privacy', seed: 'Nebenpfad.', autoRun: true,
    })
    expect(fork.seedMessageId).toBeNull()
    expect(messagesOf(fork.strandId)).toHaveLength(0)
    expect(fork.seedText).toContain('Nebenpfad.')
    expect(JSON.parse(messagesOf(parent).at(-1)!.metadata!)).toMatchObject({ autoRun: true })
  })

  it('nests: a fork of a fork of a fork keeps its own lineage', () => {
    const root = parentStrand()
    const first = forkStrand({ db, sessions, userId: 1, parentStrandId: root, title: 'L1', seed: 'Eins.' })
    const second = forkStrand({ db, sessions, userId: 1, parentStrandId: first.strandId, title: 'L2', seed: 'Zwei.' })
    const third = forkStrand({ db, sessions, userId: 1, parentStrandId: second.strandId, title: 'L3', seed: 'Drei.' })

    expect([first.depth, second.depth, third.depth]).toEqual([1, 2, 3])
    expect(forkDepthOf(db, third.strandId)).toBe(3)
    expect(listChildStrandIds(db, first.strandId)).toEqual([second.strandId])
    expect(listChildStrandIds(db, root)).toEqual([first.strandId])
  })

  it('lists siblings in fork order even when they share one forked_at', () => {
    const parent = parentStrand()
    const first = forkStrand({ db, sessions, userId: 1, parentStrandId: parent, title: 'Privacy', seed: 'Eins.' })
    const second = forkStrand({ db, sessions, userId: 1, parentStrandId: parent, title: 'Retention', seed: 'Zwei.' })
    const third = forkStrand({ db, sessions, userId: 1, parentStrandId: parent, title: 'Scopes', seed: 'Drei.' })

    // Three forks in the same millisecond is what a fast run (or a test) does;
    // the order must then still be the fork order, not the UUID order.
    const stamp = '2026-09-28T09:00:00.000Z'
    for (const child of [first, second, third]) {
      db.prepare('UPDATE sessions SET forked_at = ?, started_at = ? WHERE id = ?')
        .run(stamp, stamp, child.strandId)
    }

    expect(listChildStrandIds(db, parent)).toEqual([first.strandId, second.strandId, third.strandId])
  })

  it('refuses a chain deeper than the limit', () => {
    let current = parentStrand()
    for (let level = 1; level <= MAX_FORK_DEPTH; level += 1) {
      current = forkStrand({
        db, sessions, userId: 1, parentStrandId: current, title: `L${level}`, seed: `Ebene ${level}.`,
      }).strandId
    }
    expect(forkDepthOf(db, current)).toBe(MAX_FORK_DEPTH)
    try {
      forkStrand({ db, sessions, userId: 1, parentStrandId: current, title: 'too deep', seed: 'Noch tiefer.' })
      expect.unreachable('a fork beyond the depth limit must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ForkStrandError)
      expect((err as ForkStrandError).code).toBe('fork_depth_exceeded')
    }
  })

  it('never loops on a lineage cycle written by hand', () => {
    const a = parentStrand()
    const fork = forkStrand({ db, sessions, userId: 1, parentStrandId: a, title: 'B', seed: 'Zweig.' })
    // Only reachable through a restored backup or a manual UPDATE; the walk
    // must refuse instead of spinning.
    db.prepare('UPDATE sessions SET parent_strand_id = ? WHERE id = ?').run(fork.strandId, a)
    expect(() => forkDepthOf(db, fork.strandId)).toThrowError(/cycle/)
  })

  it('refuses a strand of another user and an archived strand', () => {
    const foreign = parentStrand(2)
    try {
      forkStrand({ db, sessions, userId: 1, parentStrandId: foreign, title: 'X', seed: 'Fremd.' })
      expect.unreachable('a foreign strand must not be forkable')
    } catch (err) {
      expect((err as ForkStrandError).code).toBe('parent_not_found')
    }
    // Nothing was written into the foreign strand.
    expect(messagesOf(foreign)).toHaveLength(2)

    const own = parentStrand(1)
    sessions.updateThread('1', own, { archived: true })
    try {
      forkStrand({ db, sessions, userId: 1, parentStrandId: own, title: 'X', seed: 'Archiviert.' })
      expect.unreachable('an archived strand must not be forkable')
    } catch (err) {
      expect((err as ForkStrandError).code).toBe('parent_archived')
    }
  })

  it('validates title and seed', () => {
    const parent = parentStrand()
    const cases: { title: string; seed: string; code: string }[] = [
      { title: '   ', seed: 'ok', code: 'invalid_title' },
      { title: 'x'.repeat(81), seed: 'ok', code: 'invalid_title' },
      { title: 'ok', seed: '  ', code: 'invalid_seed' },
      { title: 'ok', seed: 'x'.repeat(8001), code: 'invalid_seed' },
    ]
    for (const testCase of cases) {
      try {
        forkStrand({ db, sessions, userId: 1, parentStrandId: parent, title: testCase.title, seed: testCase.seed })
        expect.unreachable(`${testCase.code} must be rejected`)
      } catch (err) {
        expect((err as ForkStrandError).code).toBe(testCase.code)
      }
    }
    // No half-built strand survived a rejection.
    expect(listChildStrandIds(db, parent)).toEqual([])
  })

  it('knows when a run was started by a fork (cascade brake)', () => {
    const parent = parentStrand()
    const fork = forkStrand({
      db, sessions, userId: 1, parentStrandId: parent, title: 'Privacy', seed: 'Nebenpfad.', autoRun: true,
    })
    expect(isForkStartedRun(db, parent)).toBe(false)

    // The turn runner writes the seed as the first user message.
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', ?, 'main')",
    ).run(fork.strandId, fork.seedText)
    expect(isForkStartedRun(db, fork.strandId)).toBe(true)

    // The user's own next message makes it an ordinary strand again.
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', 'und weiter?', 'main')",
    ).run(fork.strandId)
    expect(isForkStartedRun(db, fork.strandId)).toBe(false)
  })
})

describe('ForkBudget', () => {
  it('allows three forks per scope and counts scopes apart', () => {
    const budget = new ForkBudget()
    expect(MAX_FORKS_PER_TURN).toBe(3)
    expect([budget.take('turn-1'), budget.take('turn-1'), budget.take('turn-1')]).toEqual([true, true, true])
    expect(budget.take('turn-1')).toBe(false)
    expect(budget.remaining('turn-1')).toBe(0)
    expect(budget.take('turn-2')).toBe(true)
    expect(budget.remaining('turn-2')).toBe(2)
  })
})
