import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import { createAgentRuntime } from './agent-runtime.js'
import { contextMemoryDir, resolveContextScope } from './context-scope.js'
import { getConfigDir } from './config.js'
import { createHash } from 'node:crypto'
import { saveSkills, loadSkills, type SkillConfig } from './skill-config.js'
import { listScopedAgentSkills, scopedAgentSkillsDir, getAgentSkillsDir, createAgentSkillTools } from './agent-skills.js'
import { createBaseAgentTools } from './agent-runtime.js'
import { createMemory, searchMemories } from './memories-store.js'
import { contextScopePin } from './context-scope.js'
import { runWithTaskExecutionContext } from './task-execution-context.js'
import { readContextManifest } from './context-provenance.js'

type MockMessage = { role: string; content: unknown; timestamp?: number }
type MockOptions = { initialState: { systemPrompt: string; tools: unknown[]; model: unknown }; transformContext: (messages: MockMessage[]) => Promise<unknown[]> }

const captured = vi.hoisted(() => ({ requests: [] as Array<{ system: string; messages: unknown[] }> }))
// Replace only the provider boundary. Assembly, final transform/redaction and
// provenance recording are production code; no live provider request occurs.
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: class {
  state: MockOptions['initialState'] & { messages: MockMessage[] }
  constructor(private options: MockOptions) {
    this.state = { ...options.initialState, messages: [] }
    Object.defineProperty(this.state, 'systemPrompt', { get: () => this.state.messages.find((m: MockMessage) => m.role === 'system')?.content ?? options.initialState.systemPrompt })
  }
  subscribe() { return () => {} }
  async prompt(text: string) {
    this.state.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
    captured.requests.push({ system: this.state.systemPrompt, messages: await this.options.transformContext(this.state.messages) })
  }
  abort() {}
}}))

describe('final outgoing context boundary', () => {
  it('captures real assembled payload without foreign or legacy sentinels and records bounded provenance', async () => {
    const root = path.join(process.env.WORKSPACE_DIR!, 'runtime-isolation')
    fs.mkdirSync(root, { recursive: true })
    const db = initDatabase(':memory:')
    try {
      db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'fixture','fixture')").run()
      db.prepare("INSERT INTO sessions (id, user_id, session_user, agent_id, type) VALUES ('own',1,'1','main','interactive'), ('foreign',1,'1','main','interactive')").run()
      fs.writeFileSync(path.join(root, 'MEMORY.md'), 'LEGACY_SENTINEL')
      for (const [id, text] of [['own', 'OWN_SENTINEL'], ['foreign', 'FOREIGN_SENTINEL']]) {
        const dir = contextMemoryDir(root, resolveContextScope(db, id)!)
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'MEMORY.md'), text)
      }
      const runtime = createAgentRuntime({ db, memoryDir: root, apiKey: '', model: { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'openai', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 } })
      runtime.refreshSystemPrompt('web', { username: 'fixture' }, 'main', 'own')
      for await (const _ of runtime.streamPrompt('A harmless arithmetic question.', 'own')) { /* drain */ }
      const payload = JSON.stringify(captured.requests.at(-1))
      expect(payload).toContain('OWN_SENTINEL')
      expect(payload).toContain('<agent_rules>')
      expect(payload).not.toContain('FOREIGN_SENTINEL')
      expect(payload).not.toContain('LEGACY_SENTINEL')
      const manifest = readContextManifest(db, 'own', 1, 'main')!
      expect(manifest.sources.some(s => s.source === 'scoped_memory')).toBe(true)
      expect(JSON.stringify(manifest)).not.toContain('OWN_SENTINEL')
      // Reuse one runtime without caller refresh: B -> A after global refresh.
      runtime.clearMessages()
      for await (const _ of runtime.streamPrompt('Another arithmetic question.', 'foreign')) { /* drain */ }
      expect(JSON.stringify(captured.requests.at(-1))).toContain('FOREIGN_SENTINEL')
      expect(JSON.stringify(captured.requests.at(-1))).not.toContain('OWN_SENTINEL')
      runtime.clearMessages()
      runtime.refreshSystemPrompt()
      for await (const _ of runtime.streamPrompt('Return to arithmetic.', 'own')) { /* drain */ }
      expect(JSON.stringify(captured.requests.at(-1))).toContain('OWN_SENTINEL')
      expect(JSON.stringify(captured.requests.at(-1))).not.toContain('FOREIGN_SENTINEL')
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('captures fresh B without A skill metadata; moved A retains strand memory, facts, scoped tools and child pins', async () => {
    const root = path.join(process.env.WORKSPACE_DIR!, 'final-sentinels')
    fs.mkdirSync(root, { recursive: true })
    const db = initDatabase(':memory:')
    const previous = loadSkills()
    const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text) }
    const skill = (dir: string, name: string) => write(path.join(dir, name), 'SKILL.md', `---\nname: ${name}\ndescription: ${name}_DESCRIPTION\n---\n${name}_BODY`)
    try {
      db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'fixture','fixture'),(2,'foreign','fixture')").run()
      db.prepare("INSERT INTO projects (id,user_id,name) VALUES ('A','1','A'),('B','1','B')").run()
      db.prepare("INSERT INTO sessions (id,user_id,session_user,agent_id,type,project_id) VALUES ('A',1,'1','main','interactive','A'),('B',1,'1','main','interactive','B')").run()
      const a = resolveContextScope(db, 'A')!, b = resolveContextScope(db, 'B')!
      skill(scopedAgentSkillsDir(a), 'A_SKILL_SENTINEL')
      skill(scopedAgentSkillsDir({ ...a, userId: 2 }), 'OTHER_OWNER_SKILL_SENTINEL')
      skill(scopedAgentSkillsDir({ ...a, agentId: 'coder' }), 'OTHER_PERSONA_SKILL_SENTINEL')
      skill(getAgentSkillsDir(), 'LEGACY_SKILL_SENTINEL')
      skill(getAgentSkillsDir(), 'GENERIC_APPROVED_SENTINEL')
      const approvedPath = path.join(getAgentSkillsDir(), 'GENERIC_APPROVED_SENTINEL', 'SKILL.md')
      fs.writeFileSync(path.join(getAgentSkillsDir(), '.global-approvals.json'), JSON.stringify({ GENERIC_APPROVED_SENTINEL: createHash('sha256').update(fs.readFileSync(approvedPath)).digest('hex') }))
      const installed = (name: string, contextAccess?: SkillConfig['contextAccess']): SkillConfig => ({ id: name, owner: 'fixture', name, description: `${name}_DESCRIPTION`, path: `/synthetic/${name}`, source: 'upload', sourceUrl: '', enabled: true, envKeys: [], envValues: {}, installedAt: '', contextAccess })
      saveSkills({ skills: [installed('INSTALLED_A_SENTINEL', { userId: 1, agentId: 'main', key: a.key }), installed('INSTALLED_LEGACY_SENTINEL'), installed('INSTALLED_GENERIC_SENTINEL', 'global')] })
      write(contextMemoryDir(root, a), 'MEMORY.md', 'A_MEMORY_SENTINEL')
      write(contextMemoryDir(root, b), 'MEMORY.md', 'B_MEMORY_SENTINEL')
      const runtime = createAgentRuntime({ db, memoryDir: root, apiKey: '', model: { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'openai', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 } })
      runtime.refreshSystemPrompt('web', { username: 'fixture' }, 'main', 'B')
      for await (const _ of runtime.streamPrompt('Fresh B arithmetic.', 'B')) { /* no provider */ }
      const fresh = JSON.stringify(captured.requests.at(-1))
      for (const absent of ['A_SKILL_SENTINEL', scopedAgentSkillsDir(a), 'INSTALLED_A_SENTINEL', 'LEGACY_SKILL_SENTINEL', 'INSTALLED_LEGACY_SENTINEL', 'A_MEMORY_SENTINEL']) { expect(fresh).not.toContain(absent); expect(fresh).not.toContain(absent.toLowerCase().replaceAll('_', '-')) }
      for (const present of ['B_MEMORY_SENTINEL', 'GENERIC_APPROVED_SENTINEL', 'INSTALLED_GENERIC_SENTINEL', '<agent_rules>']) expect(fresh).toContain(present)
      const discovery = createAgentSkillTools(() => b)[0]
      expect(JSON.stringify(await discovery.execute('default', {}))).not.toContain('A_SKILL_SENTINEL')
      expect(JSON.stringify(await discovery.execute('explicit', { cross_project: true }))).toContain('A_SKILL_SENTINEL')
      const explicit = JSON.stringify(await discovery.execute('explicit-again', { cross_project: true }))
      expect(explicit).not.toContain('OTHER_OWNER_SKILL_SENTINEL')
      expect(explicit).not.toContain('OTHER_PERSONA_SKILL_SENTINEL')
      expect(listScopedAgentSkills(null).map(s => s.name)).not.toContain('legacy-skill-sentinel')
      fs.appendFileSync(approvedPath, '\nChanged without reapproval')
      expect(listScopedAgentSkills(b).map(s => s.name)).not.toContain('generic-approved-sentinel')
      expect(fs.existsSync(path.join(getAgentSkillsDir(), 'LEGACY_SKILL_SENTINEL', 'SKILL.md'))).toBe(true)

      runtime.clearMessages()
      runtime.refreshSystemPrompt('web', { username: 'fixture' }, 'main', 'A')
      for await (const _ of runtime.streamPrompt('RETAINED_A_HISTORY_SENTINEL', 'A')) { /* retained history */ }
      db.prepare("UPDATE sessions SET project_id='B' WHERE id='A'").run()
      const moved = resolveContextScope(db, 'A')!
      expect(moved.key).toBe('strand:A')
      write(contextMemoryDir(root, moved), 'MEMORY.md', 'MOVED_STRAND_MEMORY_SENTINEL')
      for await (const _ of runtime.streamPrompt('Continue the retained strand.', 'A')) { /* no reset */ }
      const mixed = JSON.stringify(captured.requests.at(-1))
      expect(mixed).toContain('RETAINED_A_HISTORY_SENTINEL')
      expect(mixed).toContain('MOVED_STRAND_MEMORY_SENTINEL')
      expect(mixed).toContain('Data policy: strand-only')
      expect(mixed).not.toContain('B_MEMORY_SENTINEL')
      expect(mixed).not.toContain(contextMemoryDir(root, b))
      expect(mixed).not.toContain('A_SKILL_SENTINEL')
      createMemory(db, 1, 'A', 'MOVED_FACT_SENTINEL uses PostgreSQL')
      expect(searchMemories(db, 'MOVED_FACT_SENTINEL', { userId: 1, contextScope: b })).toEqual([])
      expect(searchMemories(db, 'MOVED_FACT_SENTINEL', { userId: 1, contextScope: moved })).toHaveLength(1)
      expect(readContextManifest(db, 'A', 1, 'main')?.policy).toBe('strand-only')

      // Real file tools: deny old-project, new-project, legacy and symlink writes.
      const tools = createBaseAgentTools({ db, memoryRoot: root, getCurrentSessionId: () => 'A', getCurrentAgentId: () => 'main', getCurrentUserId: () => 1 })
      const writer = tools.find(t => t.name === 'write_file')!
      for (const dir of [contextMemoryDir(root, a), contextMemoryDir(root, b), root, getAgentSkillsDir()]) {
        await expect(writer.execute('deny', { path: path.join(dir, 'MEMORY.md'), content: 'DENIED_SENTINEL' })).rejects.toThrow('outside current')
      }
      await expect(writer.execute('deny-approval', { path: path.join(getConfigDir(), 'skills.json'), content: '{}' })).rejects.toThrow('outside current')
      const editor = tools.find(t => t.name === 'edit_file')!
      await expect(editor.execute('deny-edit', { path: path.join(contextMemoryDir(root, b), 'MEMORY.md'), edits: [{ oldText: 'B_MEMORY_SENTINEL', newText: 'DENIED_SENTINEL' }] })).rejects.toThrow('outside current')
      fs.symlinkSync(contextMemoryDir(root, b), path.join(contextMemoryDir(root, moved), 'escape'))
      await expect(writer.execute('symlink', { path: path.join(contextMemoryDir(root, moved), 'escape', 'MEMORY.md'), content: 'DENIED_SENTINEL' })).rejects.toThrow('outside current')
      await writer.execute('own', { path: path.join(contextMemoryDir(root, moved), 'wiki', 'test.md'), content: 'SCOPED_WRITE_SENTINEL' })
      expect(fs.readFileSync(path.join(contextMemoryDir(root, b), 'MEMORY.md'), 'utf8')).toBe('B_MEMORY_SENTINEL')
      await writer.execute('create-skill', { path: path.join(scopedAgentSkillsDir(moved), 'new-skill', 'SKILL.md'), content: '---\nname: MOVED_SKILL_SENTINEL\ndescription: scoped\n---\nbody' })
      expect(listScopedAgentSkills(moved).map(s => s.name)).toContain('moved-skill-sentinel')
      expect(listScopedAgentSkills(b).map(s => s.name)).not.toContain('moved-skill-sentinel')
      db.prepare("INSERT INTO sessions(id,type,agent_id,parent_session_id,context_origin_scope) VALUES ('child','task','main','A',?)").run(contextScopePin(moved))
      expect(resolveContextScope(db, 'child')?.key).toBe('strand:A')
      runtime.clearMessages()
      for await (const _ of runtime.streamPrompt('Fresh B after mixed writes.', 'B')) { /* capture final boundary */ }
      const freshAfter = JSON.stringify(captured.requests.at(-1))
      for (const absent of ['MOVED_', 'RETAINED_A_HISTORY_SENTINEL', 'SCOPED_WRITE_SENTINEL', 'DENIED_SENTINEL', 'A_SKILL_SENTINEL']) expect(freshAfter).not.toContain(absent)
      expect(freshAfter).toContain('B_MEMORY_SENTINEL')
      // ALS takes precedence over concurrent interactive B, including incomplete lineage.
      const taskTools = createBaseAgentTools({ db, memoryRoot: root, getCurrentSessionId: () => 'B', getCurrentAgentId: () => 'main' })
      await runWithTaskExecutionContext({ provider: null, taskSessionId: 'child', agentId: 'main', userId: 1 }, async () => {
        expect(JSON.stringify(await taskTools.find(t => t.name === 'list_agent_skills')!.execute('child', {}))).toContain('moved-skill-sentinel')
      })
      await runWithTaskExecutionContext({ provider: null, taskSessionId: null, agentId: 'main', userId: 1 }, async () => {
        expect(JSON.stringify(await taskTools.find(t => t.name === 'list_agent_skills')!.execute('missing', {}))).not.toContain('moved-skill-sentinel')
        await expect(taskTools.find(t => t.name === 'write_file')!.execute('missing', { path: path.join(contextMemoryDir(root, b), 'MEMORY.md'), content: 'DENIED_SENTINEL' })).rejects.toThrow('outside current')
      })
      db.prepare("UPDATE sessions SET project_id='A' WHERE id='A'").run()
      db.prepare("UPDATE sessions SET project_id='B' WHERE id='A'").run()
      expect(resolveContextScope(db, 'A')?.key).toBe('strand:A')
      expect(resolveContextScope(db, 'child')).toBeNull()
    } finally { saveSkills(previous); db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })

})
