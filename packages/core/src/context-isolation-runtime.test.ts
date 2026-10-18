import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import { createAgentRuntime } from './agent-runtime.js'
import { contextMemoryDir, resolveContextScope } from './context-scope.js'
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
      runtime.refreshSystemPrompt('web', { username: 'fixture' })
      for await (const _ of runtime.streamPrompt('Return to arithmetic.', 'own')) { /* drain */ }
      expect(JSON.stringify(captured.requests.at(-1))).toContain('OWN_SENTINEL')
      expect(JSON.stringify(captured.requests.at(-1))).not.toContain('FOREIGN_SENTINEL')
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })
})
