import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { resolveContextScope } from './context-scope.js'

export interface ContextSource {
  source: string
  scope: 'global-policy' | 'persona' | 'project' | 'strand' | 'explicit-retrieval' | 'runtime'
  hash: string
  chars: number
  reason: string
}
export interface ContextManifest {
  version: 1
  policy: 'project-isolated' | 'strand-only'
  at: string
  sources: ContextSource[]
  /** App-side, after redaction; provider wire serialization may add wrappers. */
  boundary: 'pre-provider'
}
export function ensureContextProvenanceSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS context_manifests (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL, created_at TEXT NOT NULL, manifest TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS context_provenance_key (id INTEGER PRIMARY KEY CHECK(id = 1), key TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_context_manifest_session ON context_manifests(session_id, created_at);
  CREATE TRIGGER IF NOT EXISTS context_manifest_session_delete AFTER DELETE ON sessions BEGIN DELETE FROM context_manifests WHERE session_id = OLD.id; END;
  CREATE TRIGGER IF NOT EXISTS context_manifest_user_delete AFTER DELETE ON users BEGIN DELETE FROM context_manifests WHERE user_id = OLD.id; END;`)
  db.prepare('INSERT OR IGNORE INTO context_provenance_key VALUES (1, ?)').run(randomBytes(32).toString('hex'))
  purgeContextManifests(db)
}
/** Physical purge; called at startup, on read/write and by the maintenance timer. */
export function purgeContextManifests(db: Database): void {
  db.prepare("DELETE FROM context_manifests WHERE created_at < ? OR session_id NOT IN (SELECT id FROM sessions) OR user_id NOT IN (SELECT id FROM users)").run(new Date(Date.now() - 30 * 86400_000).toISOString())
}
/** Store only bounded metadata, NEVER a prompt dump, source text, arguments or file paths. */
export function recordContextManifest(db: Database, sessionId: string, agentId: string, systemPrompt: string, messages: readonly unknown[]): void {
  const scope = resolveContextScope(db, sessionId, agentId)
  if (!scope) return
  const key = (db.prepare('SELECT key FROM context_provenance_key WHERE id = 1').get() as { key: string }).key
  const sources: ContextSource[] = []
  const add = (source: string, category: ContextSource['scope'], text: string, reason: string) => {
    sources.push({ source, scope: category, hash: createHmac('sha256', key).update(text).digest('hex'), chars: text.length, reason })
  }
  const blocks: Array<[string, ContextSource['scope'], string]> = [
    ['agent_rules', 'global-policy', 'always-required'], ['global_rules', 'global-policy', 'always-required'],
    ['personality', 'persona', 'active-persona'], ['identity', 'persona', 'active-persona'],
    ['tool_hints', 'persona', 'active-persona'],
    ['scoped_memory', scope.projectId ? 'project' : 'strand', 'owned-session-assignment'],
    ['wiki_pages', scope.projectId ? 'project' : 'strand', 'owned-session-assignment'],
  ]
  for (const [tag, category, reason] of blocks) {
    const text = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(systemPrompt)?.[1]
    if (text != null) add(tag, category, text, reason)
  }
  add('system-prompt', 'runtime', systemPrompt, 'complete-system-envelope; overlaps-listed-blocks')
  add('outgoing-messages', 'strand', JSON.stringify(messages), 'current-turn-and-retained-strand-history')
  // Tool results are explicit retrieval, never automatic project memory. Only
  // fixed labels and hashes survive; even tool names/arguments stay out of telemetry.
  for (const msg of messages) {
    if (msg && typeof msg === 'object' && 'content' in msg) {
      const content = msg.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(p => p && typeof p === 'object' && p.type === 'text').map(p => p.text ?? '').join('\n') : ''
      for (const [tag, category, reason] of [
        ['strand_context', 'strand', 'current-strand-summary-and-retrieval'],
        ['memory_facts', scope.projectId ? 'project' : 'strand', 'scoped-fact-retrieval'],
        ['task_injection', 'strand', 'origin-strand-task-delivery'],
        ['delegation_context', 'strand', 'explicit-task-context-selection'],
      ] as Array<[string, ContextSource['scope'], string]>) {
        const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(text)
        if (match) add(tag, category, match[1], reason)
      }
    }
    if (msg && typeof msg === 'object' && 'role' in msg && msg.role === 'toolResult') {
      add('tool-result', 'explicit-retrieval', JSON.stringify(msg), 'explicit-tool-call-in-this-strand')
    }
    if (sources.length >= 100) break
  }
  const at = new Date().toISOString()
  const policy = (db.prepare('SELECT context_policy FROM sessions WHERE id = ?').get(scope.sessionId) as { context_policy: string }).context_policy
  const manifest: ContextManifest = { version: 1, policy: policy === 'strand-only' ? 'strand-only' : 'project-isolated', at, sources, boundary: 'pre-provider' }
  db.transaction(() => {
    db.prepare('INSERT INTO context_manifests VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), sessionId, scope.userId, agentId, at, JSON.stringify(manifest))
    purgeContextManifests(db)
    db.prepare('DELETE FROM context_manifests WHERE session_id = ? AND id NOT IN (SELECT id FROM context_manifests WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20)').run(sessionId, sessionId)
  })()
}
/** Caller must already authorize the strand; redundant user+persona check is intentional. */
export function readContextManifest(db: Database, sessionId: string, userId: number, agentId: string): ContextManifest | null {
  purgeContextManifests(db)
  const row = db.prepare('SELECT manifest FROM context_manifests WHERE session_id = ? AND user_id = ? AND agent_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(sessionId, userId, agentId, new Date(Date.now() - 30 * 86400_000).toISOString()) as { manifest: string } | undefined
  return row ? JSON.parse(row.manifest) as ContextManifest : null
}
