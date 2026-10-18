import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { resolveContextScope, contextMemoryDir } from './context-scope.js'
import { assembleSystemPrompt, ensureMemoryStructure, appendToDailyFile } from './memory.js'
import { createMemory, searchMemories } from './memories-store.js'
import { queryMemoriesFts } from './session-store.js'
import { createSearchMemoriesTool } from './memories-tool.js'
import { recordContextManifest, readContextManifest } from './context-provenance.js'
import { TaskStore } from './task-store.js'
import { archivePendingTaskNotices, consumePendingTaskNotices } from './task-agent-notice.js'

describe('context isolation — synthetic sentinels, no provider replay', () => {
  let db: Database
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-isolation-'))
    db = initDatabase(path.join(root, 'test.db'))
    for (const id of [1, 2]) db.prepare(`INSERT INTO users (id, username, ${'password'}_hash) VALUES (?, ?, 'fixture')`).run(id, `user${id}`)
    db.prepare("INSERT INTO projects (id, user_id, name) VALUES ('own','1','Numbers'), ('other','1','Other'), ('foreign','2','Other user')").run()
    for (const [id, owner, persona, project] of [
      ['numbers', 1, 'main', 'own'], ['same-project', 1, 'main', 'own'], ['other', 1, 'main', 'other'],
      ['new', 1, 'main', null], ['foreign', 2, 'main', 'foreign'], ['persona', 1, 'coder', 'own'],
    ]) db.prepare("INSERT INTO sessions (id, user_id, session_user, source, type, agent_id, project_id) VALUES (?, ?, ?, 'web', 'interactive', ?, ?)").run(id, owner, String(owner), persona, project)
  })
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text) }

  it('measures the assembled system payload: only own classified memory and global policy survive', () => {
    ensureMemoryStructure(root)
    write(root, 'MEMORY.md', 'LEGACY_CORE_SENTINEL')
    write(root, 'wiki/foreign.md', 'LEGACY_WIKI_SENTINEL')
    appendToDailyFile('LEGACY_DAILY_SENTINEL', undefined, root)
    const scope = resolveContextScope(db, 'numbers', 'main')!
    for (const [session, sentinel] of [['numbers', 'OWN_PROJECT_SENTINEL'], ['other', 'OTHER_PROJECT_SENTINEL'], ['foreign', 'OTHER_USER_SENTINEL'], ['persona', 'OTHER_PERSONA_SENTINEL']]) {
      write(contextMemoryDir(root, resolveContextScope(db, session)!), 'MEMORY.md', sentinel)
    }
    write(contextMemoryDir(root, scope), 'wiki/numbers.md', '---\naliases: [Numbers]\n---\nOwn wiki')
    appendToDailyFile('OWN_DAILY_ARCHIVE_SENTINEL', undefined, contextMemoryDir(root, scope))
    write(contextMemoryDir(root, { ...scope, key: 'approved-global' }), 'MEMORY.md', 'APPROVED_PREFERENCE_SENTINEL')
    const payload = assembleSystemPrompt({ memoryDir: root, contextScope: scope })
    expect(payload).toContain('OWN_PROJECT_SENTINEL')
    expect(payload).not.toContain('APPROVED_PREFERENCE_SENTINEL') // A generic file write is NOT approval.
    expect(payload).toContain('numbers.md')
    expect(payload).toContain('<agent_rules>')
    expect(payload).toContain('<personality>')
    for (const sentinel of ['LEGACY_CORE_SENTINEL','LEGACY_DAILY_SENTINEL','LEGACY_WIKI_SENTINEL','OTHER_PROJECT_SENTINEL','OTHER_USER_SENTINEL','OTHER_PERSONA_SENTINEL','OWN_DAILY_ARCHIVE_SENTINEL']) expect(payload).not.toContain(sentinel)
    expect(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8')).toBe('LEGACY_CORE_SENTINEL')
    expect(assembleSystemPrompt({ memoryDir: root })).not.toContain('OWN_PROJECT_SENTINEL')
    expect(assembleSystemPrompt({ memoryDir: root, contextScope: resolveContextScope(db, 'new')! })).not.toContain('OWN_PROJECT_SENTINEL')
  })

  it('defaults persistently to isolation; project change, strand-only and invalid ownership resolve fresh', () => {
    expect(db.prepare("SELECT context_policy FROM sessions WHERE id='numbers'").get()).toEqual({ context_policy: 'project-isolated' })
    expect(resolveContextScope(db, 'numbers')?.key).toBe('project:own')
    db.prepare("UPDATE sessions SET project_id='other' WHERE id='numbers'").run()
    expect(resolveContextScope(db, 'numbers')?.key).toBe('project:other')
    db.prepare("UPDATE sessions SET context_policy='strand-only' WHERE id='numbers'").run()
    expect(resolveContextScope(db, 'numbers')?.key).toBe('strand:numbers')
    db.prepare("UPDATE sessions SET context_policy='project-isolated', project_id='foreign' WHERE id='numbers'").run()
    expect(resolveContextScope(db, 'numbers')?.key).toBe('strand:numbers')
    expect(resolveContextScope(db, 'numbers', 'coder')).toBeNull()
    expect(resolveContextScope(db, 'missing')).toBeNull()
  })

  it('tasks inherit only authenticated lineage; independent forks and cron sessions do not inherit', () => {
    db.prepare("INSERT INTO sessions(id, source, type, agent_id, parent_session_id) VALUES ('task','task','task','main','numbers'),('nested','task','task','main','task'),('fork','web','interactive','main','numbers'),('cron','task','task','main',NULL)").run()
    expect(resolveContextScope(db, 'task')?.key).toBe('project:own')
    expect(resolveContextScope(db, 'nested')?.key).toBe('project:own')
    expect(resolveContextScope(db, 'fork')).toBeNull()
    expect(resolveContextScope(db, 'cron')).toBeNull()
    db.prepare("UPDATE sessions SET session_user='1' WHERE id IN ('fork','cron')").run()
    expect(resolveContextScope(db, 'fork')?.key).toBe('strand:fork')
    expect(resolveContextScope(db, 'cron')?.key).toBe('strand:cron')
    db.prepare("UPDATE sessions SET session_user='alice' WHERE id='task'").run()
    expect(resolveContextScope(db, 'nested')).toBeNull()
    db.prepare("UPDATE sessions SET session_user='2' WHERE id='task'").run()
    expect(resolveContextScope(db, 'task')).toBeNull()
    // Every link must agree with the owner, not just the leaf.
    expect(resolveContextScope(db, 'nested')).toBeNull()
  })

  it('rejects conflicting owners and physically cascades provenance on deletion', () => {
    recordContextManifest(db, 'numbers', 'main', 'fixture', [])
    db.prepare("UPDATE sessions SET user_id=2 WHERE id='numbers'").run()
    expect(resolveContextScope(db, 'numbers')).toBeNull()
    db.prepare("DELETE FROM sessions WHERE id='numbers'").run()
    expect(db.prepare('SELECT count(*) AS n FROM context_manifests').get()).toEqual({ n: 0 })
  })

  it('FTS and supersession cannot cross user, persona, project or unclassified legacy boundaries', () => {
    const fact = (user: number, session: string | null, text: string, persona = 'main') => createMemory(db, user, session, text, 'session', persona, { supersessionKey: 'same-subject' })
    fact(1, null, 'numbers LEGACY_FACT_SENTINEL')
    fact(1, 'other', 'numbers OTHER_FACT_SENTINEL')
    fact(2, 'foreign', 'numbers OTHER_USER_FACT_SENTINEL')
    fact(1, 'persona', 'numbers OTHER_PERSONA_FACT_SENTINEL', 'coder')
    const own = fact(1, 'numbers', 'numbers OWN_FACT_SENTINEL')
    expect(queryMemoriesFts(db, ['numbers'], 20, 'main', 'numbers').map(f => f.id)).toEqual([own])
    expect(queryMemoriesFts(db, ['numbers'], 20, 'main', 'same-project').map(f => f.id)).toEqual([own])
    expect(queryMemoriesFts(db, ['numbers'], 20, 'main', 'new')).toEqual([])
    expect(queryMemoriesFts(db, ['numbers'], 20)).toEqual([])
    expect(searchMemories(db, 'numbers', { userId: 1, includeAllProvenance: true })).toHaveLength(4)
    expect(db.prepare("SELECT count(*) AS n FROM memories WHERE status='active'").get()).toEqual({ n: 5 })
  })

  it('explicit cross-project retrieval is labelled and remains user-authorized', async () => {
    createMemory(db, 1, 'other', 'sentinel OTHER_ARCHIVE')
    createMemory(db, 2, 'foreign', 'sentinel FOREIGN_USER_ARCHIVE')
    const tool = createSearchMemoriesTool({ db, getCurrentSessionId: () => 'numbers', getCurrentUserId: () => 1, getCurrentAgentId: () => 'main' })
    const ordinary = await tool.execute('t', { query: 'sentinel' })
    expect(JSON.stringify(ordinary)).not.toContain('OTHER_ARCHIVE')
    const explicit = await tool.execute('t', { query: 'sentinel', cross_project: true })
    expect(JSON.stringify(explicit)).toContain('Explicit cross-project archive retrieval')
    expect(JSON.stringify(explicit)).toContain('OTHER_ARCHIVE')
    expect(JSON.stringify(explicit)).not.toContain('FOREIGN_USER_ARCHIVE')
  })

  it('manifest stores only bounded hashes/counts, checks user AND persona, retains latest 20', () => {
    for (let i = 0; i < 23; i++) recordContextManifest(db, 'numbers', 'main', '<agent_rules>SECRET_SENTINEL</agent_rules><scoped_memory>PROJECT_SENTINEL</scoped_memory>', [{ role: 'toolResult', content: 'PRIVATE_TOOL_SENTINEL' }])
    const manifest = readContextManifest(db, 'numbers', 1, 'main')!
    expect(manifest.sources.find(s => s.source === 'scoped_memory')?.scope).toBe('project')
    expect(manifest.sources.find(s => s.source === 'tool-result')?.scope).toBe('explicit-retrieval')
    expect(JSON.stringify(manifest)).not.toMatch(/SECRET_SENTINEL|PROJECT_SENTINEL|PRIVATE_TOOL_SENTINEL/)
    expect(manifest.sources.every(s => /^[a-f0-9]{64}$/.test(s.hash))).toBe(true)
    expect(readContextManifest(db, 'numbers', 2, 'main')).toBeNull()
    expect(readContextManifest(db, 'numbers', 1, 'coder')).toBeNull()
    expect(db.prepare('SELECT count(*) AS n FROM context_manifests').get()).toEqual({ n: 20 })
    db.prepare("UPDATE context_manifests SET created_at='2000-01-01'").run()
    expect(readContextManifest(db, 'numbers', 1, 'main')).toBeNull()
    expect(db.prepare('SELECT count(*) AS n FROM context_manifests').get()).toEqual({ n: 0 })
  })

  it('legacy notice migration is durable, idempotent and never injects into prompts', () => {
    const store = new TaskStore(db)
    const task = store.create({ name: 'fixture', prompt: 'fixture', triggerType: 'cronjob', sessionId: 'numbers', agentId: 'main' })
    store.update(task.id, { status: 'completed', resultSummary: 'NOTICE_SENTINEL', resultStatus: 'completed' })
    expect(archivePendingTaskNotices(db).delivered).toBe(1)
    expect(archivePendingTaskNotices(db).delivered).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM feed_items WHERE task_id=?').get(task.id)).toEqual({ n: 1 })
    expect(consumePendingTaskNotices(db, { agentId: 'main' })).toBeNull()
    expect(store.getById(task.id)?.resultSummary).toBe('NOTICE_SENTINEL')
  })
  it('archives non-cron outcomes only to the correct owner, quarantines unknown owners and preserves silent outcomes', () => {
    const store = new TaskStore(db)
    const known = store.create({ name: 'owned', prompt: 'fixture', triggerType: 'heartbeat', sessionId: 'numbers' })
    const unknown = store.create({ name: 'unknown', prompt: 'fixture', triggerType: 'agent' })
    const silent = store.create({ name: 'silent', prompt: 'fixture', triggerType: 'cronjob', sessionId: 'numbers' })
    for (const task of [known, unknown]) store.update(task.id, { status: 'completed', resultSummary: 'ARCHIVE_SENTINEL', resultStatus: 'completed' })
    store.update(silent.id, { status: 'completed', resultSummary: 'SILENT_SENTINEL', resultStatus: 'silent' })
    db.prepare("INSERT INTO feed_items (id, user_id, kind, title, task_id) VALUES ('foreign-feed', '2', 'task_result', 'fixture', ?)").run(known.id)
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 1, quarantined: 1 })
    expect(db.prepare('SELECT user_id FROM feed_items WHERE task_id=? ORDER BY user_id').all(known.id)).toEqual([{ user_id: '1' }, { user_id: '2' }])
    expect(db.prepare('SELECT count(*) AS n FROM feed_items WHERE task_id=?').get(unknown.id)).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM feed_items WHERE task_id=?').get(silent.id)).toEqual({ n: 0 })
    expect(store.getById(unknown.id)?.resultSummary).toBe('ARCHIVE_SENTINEL')
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 0, quarantined: 1 })
  })

})
