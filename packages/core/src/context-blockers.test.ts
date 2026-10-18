// Regression fixtures derived from review-repro-ctx/repro-{consolidation,createthread}.ts.
// Synthetic data only; no provider calls or production database.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase, type Database } from './database.js'
import { SessionManager } from './session-manager.js'
import { resolveContextScope, resolveFactWriteScope, contextMemoryDir } from './context-scope.js'
import { scopedConsolidationTools } from './consolidation-tools.js'
import { assignProjectIfUnset } from './project-assignment-store.js'
import { archivePendingTaskNotices } from './task-agent-notice.js'
import { TaskStore } from './task-store.js'

describe('independent review blocker regressions', () => {
  let db: Database
  let root: string
  let sm: SessionManager
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.context-blockers-'))
    db = initDatabase(path.join(root, 'synthetic.db'))
    for (const id of [1, 2]) db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, `fixture${id}`, 'fixture', id === 1 ? 'admin' : 'user')
    db.prepare("INSERT INTO projects (id,user_id,name) VALUES ('A','1','A'),('B','1','B')").run()
    db.prepare("INSERT INTO sessions (id,user_id,session_user,type,agent_id,project_id) VALUES ('S',1,'1','interactive','main','A')").run()
    sm = new SessionManager({ db, memoryDir: root })
  })
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const changes = [
    ["UPDATE sessions SET project_id='B' WHERE id='S'"],
    ["UPDATE sessions SET project_id='B' WHERE id='S'", "UPDATE sessions SET project_id='A' WHERE id='S'"],
    ["UPDATE sessions SET user_id=2,session_user='2' WHERE id='S'", "UPDATE sessions SET user_id=1,session_user='1' WHERE id='S'"],
    ["UPDATE sessions SET agent_id='coder' WHERE id='S'", "UPDATE sessions SET agent_id='main' WHERE id='S'"],
    ["UPDATE sessions SET context_policy='strand-only' WHERE id='S'", "UPDATE sessions SET context_policy='project-isolated' WHERE id='S'"],
  ]
  function consolidation(pin = true) {
    return sm.createSession({ type: 'consolidation', source: 'system', userId: '1', agentId: 'main', parentSessionId: 'S',
      contextOriginScope: pin ? JSON.stringify([1, 'project:A']) : undefined }).id
  }
  it('rejects a legacy consolidation with no origin pin, even before a move', () => {
    const id = consolidation(false)
    expect(resolveContextScope(db, id, 'main')).toBeNull()
    db.prepare("UPDATE sessions SET project_id='B' WHERE id='S'").run()
    expect(resolveContextScope(db, id, 'main')).toBeNull()
  })
  it.each(changes.map((sql, i) => ({ sql, i })))('revokes queued and active capabilities for change $i, including change-back', async ({ sql }) => {
    const id = consolidation()
    const scope = resolveContextScope(db, id, 'main')!
    expect(scope.key).toBe('project:A')
    const dir = contextMemoryDir(root, scope)
    const execute = vi.fn(async () => ({ content: [], details: {} }))
    const tools = ['read_chat_history', 'write_file', 'edit_file', 'read_file', 'list_files'].map(name => ({ name, execute })) as unknown as AgentTool[]
    const scoped = scopedConsolidationTools(tools, dir, 'S', () => {
      if (!resolveContextScope(db, id, 'main')) throw new Error('revoked')
    })
    await scoped[0].execute('before', { session_id: 'foreign' })
    expect(execute).toHaveBeenCalledOnce()
    for (const statement of sql) db.prepare(statement).run()
    expect(resolveContextScope(db, id, 'main')).toBeNull()
    for (const tool of scoped) await expect(tool.execute('after', { path: 'MEMORY.md', content: 'B_SENTINEL' })).rejects.toThrow('revoked')
    expect(execute).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(false)
  })
  it('discards an in-flight history read that crosses reassignment', async () => {
    const id = consolidation()
    const dir = contextMemoryDir(root, resolveContextScope(db, id)!)
    const tool = { name: 'read_chat_history', execute: async () => {
      await Promise.resolve()
      db.prepare("UPDATE sessions SET project_id='B' WHERE id='S'").run()
      return { content: [{ type: 'text', text: 'B_SENTINEL' }], details: {} }
    } } as unknown as AgentTool
    const [scoped] = scopedConsolidationTools([tool], dir, 'S', () => {
      if (!resolveContextScope(db, id)) throw new Error('revoked')
    })
    await expect(scoped.execute('read', {})).rejects.toThrow('revoked')
  })
  it('creates a project strand without marking initial assignment as a move', () => {
    const thread = sm.createThread('1', 'main', 'Fresh', 'A')
    expect(db.prepare('SELECT project_id,context_origin_scope FROM sessions WHERE id=?').get(thread.id)).toEqual({ project_id: 'A', context_origin_scope: null })
    expect(resolveFactWriteScope(db, thread.id)?.key).toBe('project:A')
    expect(db.prepare("SELECT count(*) n FROM sessions WHERE id=? AND type='interactive' AND context_origin_scope IS NOT 'scope-changed'").get(thread.id)).toEqual({ n: 1 })
  })
  it('permits an initial automatic assignment only for an empty strand', () => {
    const empty = sm.createThread('1')
    expect(assignProjectIfUnset(db, empty.id, '1', 'A')).toBe(true)
    expect(resolveFactWriteScope(db, empty.id)?.key).toBe('project:A')
    const history = sm.createThread('1')
    // message_count is deliberately stale/zero: raw retained history must count.
    db.prepare("INSERT INTO chat_messages(session_id,role,content) VALUES (?,'user','UNASSIGNED_SENTINEL')").run(history.id)
    expect(assignProjectIfUnset(db, history.id, '1', 'A')).toBe(true)
    expect(resolveFactWriteScope(db, history.id)?.key).toBe(`strand:${history.id}`)
    expect(db.prepare('SELECT content FROM chat_messages WHERE session_id=?').get(history.id)).toEqual({ content: 'UNASSIGNED_SENTINEL' })
  })
  it('never resets sticky history on a later NULL-to-project assignment', () => {
    db.prepare("UPDATE sessions SET project_id=NULL WHERE id='S'").run()
    expect(assignProjectIfUnset(db, 'S', '1', 'A')).toBe(true)
    expect(resolveFactWriteScope(db, 'S')?.key).toBe('strand:S')
  })
  it('rolls migration cards and markers back together when the batch cannot commit', () => {
    const store = new TaskStore(db)
    const task = store.create({ name: 'cron fixture', prompt: 'synthetic', triggerType: 'cronjob', sessionId: 'S' })
    store.update(task.id, { status: 'completed', resultSummary: 'PRESERVED_SENTINEL' })
    db.exec("CREATE TABLE context_notice_migrations(version TEXT PRIMARY KEY); CREATE TRIGGER fixture_batch_failure BEFORE INSERT ON context_notice_migrations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    expect(() => archivePendingTaskNotices(db)).toThrow('synthetic failure')
    expect(db.prepare('SELECT count(*) n FROM feed_items').get()).toEqual({ n: 0 })
    expect(store.getById(task.id)?.agentNotifiedAt).toBeNull()
    expect(store.getById(task.id)?.resultSummary).toBe('PRESERVED_SENTINEL')
    db.exec('DROP TRIGGER fixture_batch_failure')
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 1, quarantined: 0 })
    expect(store.getById(task.id)?.agentNotifiedAt).toBeTruthy()
  })
  it('migrates only legacy cron notices once; preserves internal, delivered, silent and future outcomes', () => {
    const store = new TaskStore(db)
    const ids: string[] = []
    for (const triggerType of ['user', 'agent', 'consolidation', 'heartbeat', 'cronjob'] as const) {
      const task = store.create({ name: triggerType, prompt: 'fixture', triggerType, sessionId: 'S' })
      store.update(task.id, { status: 'completed', resultSummary: 'RESULT_SENTINEL' })
      ids.push(task.id)
    }
    db.prepare("INSERT INTO feed_items(id,user_id,kind,title,task_id) VALUES ('parent-card','1','task_result','parent',?)").run(ids[0])
    const unknown = store.create({ name: 'unknown cron', prompt: 'fixture', triggerType: 'cronjob' })
    store.update(unknown.id, { status: 'completed', resultSummary: 'UNKNOWN_SENTINEL' })
    const silent = store.create({ name: 'silent', prompt: 'fixture', triggerType: 'cronjob', sessionId: 'S' })
    store.update(silent.id, { status: 'completed', resultStatus: 'silent' })
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 1, quarantined: 1 })
    expect(db.prepare('SELECT task_id FROM feed_items WHERE task_id IS NOT NULL ORDER BY task_id').all()).toEqual([ids[0], ids[4]].sort().map(task_id => ({ task_id })))
    expect(db.prepare('SELECT task_id,reason FROM context_notice_quarantine').all()).toEqual([{ task_id: unknown.id, reason: 'untrusted-owner' }])
    const future = store.create({ name: 'future', prompt: 'fixture', triggerType: 'cronjob', sessionId: 'S' })
    store.update(future.id, { status: 'completed' })
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 0, quarantined: 0 })
    expect(db.prepare('SELECT count(*) n FROM feed_items').get()).toEqual({ n: 3 }) // parent, cron, one admin card
    expect(store.getById(future.id)?.agentNotifiedAt).toBeNull()
    expect(store.getById(unknown.id)?.resultSummary).toBe('UNKNOWN_SENTINEL')
    // Reopen as a real second boot; marker and quarantine survive.
    db.close(); db = initDatabase(path.join(root, 'synthetic.db'))
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 0, quarantined: 0 })
    expect(db.prepare('SELECT count(*) n FROM feed_items').get()).toEqual({ n: 3 })
  })
})
