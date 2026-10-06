/**
 * Persona delegation (plan persona-architektur 1c): persona directory,
 * delegation rights, the `<cross_persona>` prompt block and the delegation
 * protocol table. Synthetic fixtures only (temp dirs, temp DB).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  formatPersonaDirectoryLine,
  listActivePersonaIds,
  listPersonaDirectory,
  readPersonaDirectoryEntry,
  resolveDelegationTarget,
} from './persona-directory.js'
import { buildAskAgentPromptHint } from './ask-agent-tool.js'
import {
  finishTaskDelegation,
  listPersonaDelegations,
  recordPersonaDelegation,
} from './persona-delegation-log.js'
import { taskOwnerAgentId } from './task-store.js'

function writePersona(baseDir: string, id: string, identity: string): void {
  fs.mkdirSync(path.join(baseDir, id), { recursive: true })
  fs.writeFileSync(path.join(baseDir, id, 'IDENTITY.md'), identity, 'utf-8')
}

const BUILDER_IDENTITY = [
  '# IDENTITY',
  '- **Name:** Builder',
  '- **Emoji:** 🔨',
  '- **Role:** Handwerker für Code und Deploys',
  '- **Model:** test-model',
  '',
  '<!-- offtangent:subjects:start -->',
  '- code',
  '- deploys',
  '- reviews',
  '- ci',
  '- docker',
  '- git',
  '- seventh subject is cut',
  '<!-- offtangent:subjects:end -->',
].join('\n')

// Legacy template: `Creature:` / `Vibe:` and no subjects block.
const QUANT_IDENTITY = [
  '# IDENTITY',
  '- **Name:** Quant',
  '- **Creature:** Trader mit Bauchgefühl',
  '- **Emoji:** 💹',
].join('\n')

describe('persona directory', () => {
  let baseDir: string
  let db: Database
  let dbPath: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-dir-'))
    writePersona(baseDir, 'builder', BUILDER_IDENTITY)
    writePersona(baseDir, 'quant', QUANT_IDENTITY)
    writePersona(baseDir, 'marketer', '- **Name:** Marketer\n- **Role:** archived marketing\n')
    fs.mkdirSync(path.join(baseDir, 'main'), { recursive: true })
    dbPath = path.join(baseDir, 'test.db')
    db = initDatabase(dbPath)
    db.prepare("INSERT INTO personas (id, archived) VALUES ('marketer', 1)").run()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('lists main first, then folder personas sorted, archived ones left out', () => {
    expect(listActivePersonaIds({ baseDir, db })).toEqual(['main', 'builder', 'quant'])
    // Without a database nothing is known to be archived.
    expect(listActivePersonaIds({ baseDir })).toEqual(['main', 'builder', 'marketer', 'quant'])
  })

  it('reads name, badge, role, at most six subjects and the model from IDENTITY.md', () => {
    const builder = readPersonaDirectoryEntry('builder', baseDir)
    expect(builder).toEqual({
      id: 'builder',
      name: 'Builder',
      badge: '🔨',
      role: 'Handwerker für Code und Deploys',
      subjects: ['code', 'deploys', 'reviews', 'ci', 'docker', 'git'],
      model: 'test-model',
    })
    expect(formatPersonaDirectoryLine(builder)).toBe(
      '- builder 🔨 Builder: Handwerker für Code und Deploys Subjects: code; deploys; reviews; ci; docker; git',
    )
  })

  it('reads the legacy Creature label as role and survives a persona without IDENTITY.md', () => {
    expect(readPersonaDirectoryEntry('quant', baseDir).role).toBe('Trader mit Bauchgefühl')
    const ghost = readPersonaDirectoryEntry('ghost', baseDir)
    expect(ghost).toMatchObject({ id: 'ghost', name: null, role: null, subjects: [] })
    expect(formatPersonaDirectoryLine(ghost)).toBe('- ghost')
  })

  it('builds a deterministic cross_persona block with roles and subjects, no archived personas', () => {
    const first = buildAskAgentPromptHint('main', baseDir, db)
    const second = buildAskAgentPromptHint('main', baseDir, db)
    expect(first).toBe(second)
    expect(first).toContain('<cross_persona>')
    expect(first).toContain('- builder 🔨 Builder: Handwerker für Code und Deploys Subjects: code; deploys; reviews; ci; docker; git')
    expect(first).toContain('- quant 💹 Quant: Trader mit Bauchgefühl')
    expect(first).not.toContain('marketer')
    expect(first).not.toContain('seventh subject')
    // main does not list itself, builder comes before quant.
    expect(first).not.toMatch(/^- main/m)
    expect(first.indexOf('- builder')).toBeLessThan(first.indexOf('- quant'))
    // Only the default persona learns about create_task with persona.
    expect(first).toContain('create_task with persona="<id>"')
    expect(first).toContain('verbatim')
  })

  it('shows main to other personas and does not offer them create_task delegation', () => {
    const hint = buildAskAgentPromptHint('builder', baseDir, db)
    expect(hint).toMatch(/^- main: default persona/m)
    expect(hint).not.toMatch(/^- builder/m)
    expect(hint).not.toContain('create_task with persona')
  })

  it('returns an empty block when there is nobody else', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-dir-empty-'))
    try {
      expect(buildAskAgentPromptHint('main', empty)).toBe('')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('listPersonaDirectory keeps the order of listActivePersonaIds', () => {
    expect(listPersonaDirectory({ baseDir, db }).map(e => e.id)).toEqual(['main', 'builder', 'quant'])
  })

  describe('resolveDelegationTarget (create_task persona rights)', () => {
    it('no persona or the caller itself runs as the caller', () => {
      expect(resolveDelegationTarget({ requested: undefined, callerAgentId: 'main', baseDir, db }))
        .toEqual({ ok: true, personaId: 'main', foreign: false })
      expect(resolveDelegationTarget({ requested: '  ', callerAgentId: 'builder', baseDir, db }))
        .toEqual({ ok: true, personaId: 'builder', foreign: false })
      expect(resolveDelegationTarget({ requested: 'builder', callerAgentId: 'builder', baseDir, db }))
        .toEqual({ ok: true, personaId: 'builder', foreign: false })
      // A caller without persona context counts as main.
      expect(resolveDelegationTarget({ requested: 'main', callerAgentId: undefined, baseDir, db }))
        .toEqual({ ok: true, personaId: 'main', foreign: false })
    })

    it('the default persona may delegate to an active persona', () => {
      expect(resolveDelegationTarget({ requested: 'builder', callerAgentId: 'main', baseDir, db }))
        .toEqual({ ok: true, personaId: 'builder', foreign: true })
    })

    it('another persona may not delegate, not even to main', () => {
      const toQuant = resolveDelegationTarget({ requested: 'quant', callerAgentId: 'builder', baseDir, db })
      expect(toQuant.ok).toBe(false)
      if (!toQuant.ok) expect(toQuant.error).toContain('only the default persona (main)')
      expect(resolveDelegationTarget({ requested: 'main', callerAgentId: 'builder', baseDir, db }).ok).toBe(false)
    })

    it('unknown and archived personas fail with the list of valid ids', () => {
      const unknown = resolveDelegationTarget({ requested: 'nobody', callerAgentId: 'main', baseDir, db })
      expect(unknown).toEqual({ ok: false, error: 'persona "nobody" is unknown. Valid personas: main, builder, quant.' })
      const archived = resolveDelegationTarget({ requested: 'marketer', callerAgentId: 'main', baseDir, db })
      expect(archived).toEqual({ ok: false, error: 'persona "marketer" is archived. Valid personas: main, builder, quant.' })
    })

    it('honours a default flag on another persona', () => {
      db.prepare('UPDATE personas SET is_default = 0').run()
      db.prepare("INSERT INTO personas (id, is_default) VALUES ('quant', 1)").run()
      expect(resolveDelegationTarget({ requested: 'builder', callerAgentId: 'quant', baseDir, db }).ok).toBe(true)
      expect(resolveDelegationTarget({ requested: 'builder', callerAgentId: 'main', baseDir, db }).ok).toBe(false)
    })
  })
})

describe('taskOwnerAgentId (delivery routing)', () => {
  it('routes a delegated task to the delegator, everything else as before', () => {
    expect(taskOwnerAgentId({ agentId: 'builder', delegatedBy: 'main' })).toBe('main')
    expect(taskOwnerAgentId({ agentId: 'builder', delegatedBy: null })).toBe('builder')
    expect(taskOwnerAgentId({ agentId: null, delegatedBy: null })).toBe('main')
    expect(taskOwnerAgentId({ agentId: 'builder' })).toBe('builder')
  })
})

describe('persona delegation protocol', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-log-'))
    db = initDatabase(path.join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates the table idempotently with the expected columns', () => {
    const cols = (db.prepare('PRAGMA table_info(persona_delegations)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'created_at', 'caller_agent_id', 'target_agent_id', 'kind', 'task_id', 'session_id',
      'success', 'duration_ms', 'input_tokens', 'output_tokens', 'cost_usd', 'error', 'finished_at',
    ]))
    // A second init on the same file is a no-op.
    db.close()
    db = initDatabase(path.join(dir, 'test.db'))
    expect(listPersonaDelegations(db)).toEqual([])
  })

  it('records a finished ask_agent call with tokens and cost', () => {
    const id = recordPersonaDelegation(db, {
      callerAgentId: 'main', targetAgentId: 'builder', kind: 'ask_agent',
      success: true, durationMs: 1234, inputTokens: 100, outputTokens: 50, costUsd: 0.002,
    })
    expect(id).toBeGreaterThan(0)
    const [row] = listPersonaDelegations(db)
    expect(row).toMatchObject({
      callerAgentId: 'main', targetAgentId: 'builder', kind: 'ask_agent', taskId: null,
      success: true, durationMs: 1234, inputTokens: 100, outputTokens: 50, costUsd: 0.002, error: null,
    })
    expect(row.finishedAt).not.toBeNull()
  })

  it('keeps a task row open until the task finishes, then closes it from the task row', () => {
    db.prepare(`INSERT INTO tasks (id, name, prompt, status, trigger_type, agent_id, delegated_by, created_at, started_at)
      VALUES ('t1', 'n', 'p', 'running', 'agent', 'builder', 'main', '2026-01-01 10:00:00', '2026-01-01 10:00:00')`).run()
    recordPersonaDelegation(db, { callerAgentId: 'main', targetAgentId: 'builder', kind: 'task', taskId: 't1', sessionId: 's1' })
    expect(listPersonaDelegations(db)[0]).toMatchObject({ success: null, finishedAt: null, sessionId: 's1' })

    // Still running: nothing changes.
    finishTaskDelegation(db, 't1')
    expect(listPersonaDelegations(db)[0].finishedAt).toBeNull()

    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = '2026-01-01 10:02:00',
      prompt_tokens = 900, completion_tokens = 80, estimated_cost = 0.05 WHERE id = 't1'`).run()
    finishTaskDelegation(db, 't1')
    expect(listPersonaDelegations(db)[0]).toMatchObject({
      success: true, durationMs: 120_000, inputTokens: 900, outputTokens: 80, costUsd: 0.05, error: null,
    })
    // Idempotent: a second close does not touch the closed row.
    const before = listPersonaDelegations(db)[0]
    finishTaskDelegation(db, 't1')
    expect(listPersonaDelegations(db)[0]).toEqual(before)
  })

  it('closes a failed task as failure with its error', () => {
    db.prepare(`INSERT INTO tasks (id, name, prompt, status, trigger_type, agent_id, delegated_by, created_at, error_message)
      VALUES ('t2', 'n', 'p', 'failed', 'agent', 'builder', 'main', '2026-01-01 10:00:00', 'boom')`).run()
    recordPersonaDelegation(db, { callerAgentId: 'main', targetAgentId: 'builder', kind: 'task', taskId: 't2' })
    finishTaskDelegation(db, 't2')
    expect(listPersonaDelegations(db)[0]).toMatchObject({ success: false, error: 'boom' })
  })

  it('never throws without a database', () => {
    expect(recordPersonaDelegation(null, { callerAgentId: 'main', targetAgentId: 'builder', kind: 'ask_agent' })).toBeNull()
    expect(() => finishTaskDelegation(undefined, 'x')).not.toThrow()
  })
})
