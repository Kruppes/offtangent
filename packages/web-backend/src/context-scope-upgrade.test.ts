// Upgrade fixtures adapted from review-repro-ctx/final-scope-upgrade.mts.
// Synthetic databases only: old markers did not record WHY the scope changed.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase, initDatabase, type Database } from '../../core/src/database.js'
import { contextMemoryDir, resolveContextScope, resolveFactWriteScope } from '../../core/src/context-scope.js'
import { SessionManager } from '../../core/src/session-manager.js'
import { MemoryConsolidationScheduler } from './memory-consolidation-scheduler.js'

const legacy = [
  { id: '00000000-0000-4000-8000-000000000001', user: 1, agent: 'builder', oldUser: 1, oldAgent: 'alice', text: 'ALICE_PERSONA_SENTINEL' },
  { id: '00000000-0000-4000-8000-000000000002', user: 2, agent: 'main', oldUser: 1, oldAgent: 'main', text: 'USER1_HISTORY_SENTINEL' },
  { id: '00000000-0000-4000-8000-000000000003', user: 1, agent: 'main', oldUser: 1, oldAgent: 'main', text: 'MOVED_A_SENTINEL' },
]

describe('legacy scope-changed upgrade quarantine', () => {
  let db: Database
  let root: string
  let dbPath: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.env.WORKSPACE_DIR!, 'scope-upgrade-'))
    dbPath = path.join(root, 'fixture.db')
    db = initDatabase(dbPath)
    const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
    const hashColumn = columns.find(c => c.name.endsWith('_hash'))!.name
    db.exec(`INSERT INTO users(id,username,${hashColumn}) VALUES (1,'fixture1','fixture'),(2,'fixture2','fixture')`)
    db.exec("INSERT INTO projects(id,user_id,name) VALUES ('A','1','Alpha'),('B','1','Beta')")
  })
  afterEach(() => {
    if (db?.open) db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function oldSchema(stage: 'legacy' | 'revision-only' | 'identity-only' | 'columns' | 'pre-fix-complete') {
    // Simulate both a dd355659 database and interruptions between e379's DDL
    // statements. A completed e379 schema still cannot prove marker provenance.
    db.exec('DELETE FROM context_scope_migrations')
    if (stage !== 'pre-fix-complete') db.exec('DROP TRIGGER context_fact_scope_changed')
    if (stage === 'legacy' || stage === 'revision-only') db.exec('ALTER TABLE sessions DROP COLUMN context_identity_changed')
    if (stage === 'legacy' || stage === 'identity-only') db.exec('ALTER TABLE sessions DROP COLUMN context_scope_revision')
    for (const row of legacy) {
      db.prepare("INSERT INTO sessions(id,user_id,agent_id,project_id,context_origin_scope,message_count) VALUES (?,?,?,'B','scope-changed',2)").run(row.id, row.user, row.agent)
      db.prepare("INSERT INTO chat_messages(session_id,user_id,agent_id,role,content) VALUES (?,?,?,'user',?)").run(row.id, row.oldUser, row.oldAgent, row.text)
    }
    db.exec("INSERT INTO memories(user_id,agent_id,session_id,content,context_scope) VALUES (1,'builder','00000000-0000-4000-8000-000000000001','LEGACY_UNCLASSIFIED_FACT',NULL)")
  }
  function reopen() { db.close(); db = initDatabase(dbPath) }
  function preservedData() {
    return {
      chat: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      facts: db.prepare('SELECT * FROM memories ORDER BY id').all(),
    }
  }
  function assertQuarantined() {
    for (const row of legacy) {
      expect(db.prepare('SELECT context_identity_changed FROM sessions WHERE id=?').get(row.id)).toEqual({ context_identity_changed: 1 })
      expect(resolveContextScope(db, row.id, row.agent)).toBeNull() // prompt + consolidation gate
      expect(resolveFactWriteScope(db, row.id)).toBeNull() // extraction + daily gate
    }
  }

  it.each(['legacy', 'revision-only', 'identity-only', 'columns', 'pre-fix-complete'] as const)(
    'quarantines every unknown historical reason from %s without losing data', (stage) => {
      oldSchema(stage)
      const before = preservedData()
      reopen()
      assertQuarantined()
      expect(preservedData()).toEqual(before)
      expect(db.prepare('SELECT * FROM context_scope_migrations').all()).toEqual([{ version: 'identity-quarantine-v1' }])
      const sessions = db.prepare('SELECT * FROM sessions ORDER BY id').all()
      reopen()
      assertQuarantined()
      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(sessions)
      expect(preservedData()).toEqual(before)
    },
  )

  it('does not trust a retained version marker when required columns are missing', () => {
    oldSchema('legacy')
    db.exec("INSERT INTO context_scope_migrations(version) VALUES ('identity-quarantine-v1')")
    reopen()
    assertQuarantined()
  })

  it('blocks actual daily writes and consolidation tasks even with existing strand dailies', async () => {
    oldSchema('legacy')
    const memoryDir = path.join(process.env.DATA_DIR!, 'memory')
    // These are exactly the directories the broken migration would expose.
    for (const row of legacy) {
      const scope = resolveContextScope(db, row.id, row.agent)!
      expect(scope.key).toBe(`strand:${row.id}`)
      const dir = contextMemoryDir(memoryDir, scope)
      fs.mkdirSync(path.join(dir, 'daily'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'daily', `${new Date().toISOString().slice(0, 10)}.md`), 'ARCHIVED_DAILY_SENTINEL '.repeat(30))
    }
    reopen()
    const outputDir = path.join(root, 'daily-output')
    const manager = new SessionManager({ db, memoryDir: outputDir, scopedAgentMemory: false })
    const writer = manager as unknown as { writeSummaryToDailyFile: (summary: string, timestamp: number, agent: string, id: string) => void }
    for (const row of legacy) writer.writeSummaryToDailyFile(row.text, Date.now(), row.agent, row.id)
    expect(fs.existsSync(outputDir)).toBe(false)
    const runtime = { create: vi.fn(), start: vi.fn(), getById: vi.fn() }
    const scheduler = new MemoryConsolidationScheduler({
      db, taskRuntime: runtime,
      getDefaultProvider: () => ({ id: 'fixture', name: 'Fixture', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://invalid.test', apiKey: '', enabledModels: ['fixture'] }),
    })
    const result = await scheduler.runNow()
    expect(result.dailyFilesReviewed).toBe(0)
    expect(result.reason).toBe('No scoped daily files to consolidate')
    expect(runtime.create).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    assertQuarantined()
  })

  it('retains fresh project-only strand scopes across repeated initDatabase calls', () => {
    oldSchema('legacy')
    reopen()
    const fresh = '00000000-0000-4000-8000-000000000004'
    db.prepare("INSERT INTO sessions(id,user_id,agent_id,project_id,message_count) VALUES (?,1,'main','A',1)").run(fresh)
    db.prepare("INSERT INTO chat_messages(session_id,role,content) VALUES (?,'user','FRESH_A_HISTORY')").run(fresh)
    db.prepare("UPDATE sessions SET project_id='B' WHERE id=?").run(fresh)
    const before = db.prepare('SELECT * FROM sessions WHERE id=?').get(fresh)
    const data = preservedData()
    for (let boot = 0; boot < 2; boot++) {
      expect(resolveContextScope(db, fresh)?.key).toBe(`strand:${fresh}`)
      expect(resolveFactWriteScope(db, fresh)?.key).toBe(`strand:${fresh}`)
      expect(db.prepare('SELECT context_identity_changed FROM sessions WHERE id=?').get(fresh)).toEqual({ context_identity_changed: 0 })
      reopen()
      expect(db.prepare('SELECT * FROM sessions WHERE id=?').get(fresh)).toEqual(before)
      expect(preservedData()).toEqual(data)
      assertQuarantined()
    }
    for (const change of ["agent_id='builder'", 'user_id=2']) {
      db.prepare(`UPDATE sessions SET ${change} WHERE id=?`).run(fresh)
      expect(resolveContextScope(db, fresh)).toBeNull()
    }
  })

  it.each(['legacy', 'columns'] as const)('rolls back %s DDL/quarantine/trigger changes on a version commit failure, then retries', (stage) => {
    oldSchema(stage)
    db.exec("CREATE TRIGGER context_fact_scope_changed AFTER UPDATE OF project_id ON sessions BEGIN UPDATE sessions SET context_origin_scope='scope-changed' WHERE id=NEW.id; END")
    const oldTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='context_fact_scope_changed'").get()
    const data = preservedData()
    db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON context_scope_migrations BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END")
    db.close()
    expect(() => initDatabase(dbPath)).toThrow('fixture interruption')
    db = getDatabase()
    expect(db.inTransaction).toBe(false)
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    for (const column of ['context_identity_changed', 'context_scope_revision']) {
      expect(columns.some(c => c.name === column)).toBe(stage === 'columns')
    }
    if (stage === 'columns') {
      expect(db.prepare('SELECT context_identity_changed FROM sessions').all()).toEqual(legacy.map(() => ({ context_identity_changed: 0 })))
    }
    expect(db.prepare('SELECT * FROM context_scope_migrations').all()).toEqual([])
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='context_fact_scope_changed'").get()).toEqual(oldTrigger)
    expect(preservedData()).toEqual(data)
    db.exec('DROP TRIGGER fixture_failure')
    reopen()
    assertQuarantined()
    expect(preservedData()).toEqual(data)
  })
})
