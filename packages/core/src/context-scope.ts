import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Database } from './database.js'

/** Data scope, independent of global policy. Unknown ownership fails closed. */
export interface ContextScope {
  userId: number
  agentId: string
  sessionId: string
  projectId: string | null
  key: string
}
type ScopeRow = { id: string; user_id: number | null; session_user: string | null; agent_id: string; project_id: string | null; type: string; context_policy?: string; parent_session_id: string | null }
export function resolveContextScope(db: Database, sessionId?: string, agentId?: string): ContextScope | null {
  if (!sessionId) return null
  const start = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as ScopeRow | undefined
  if (!start || (agentId && start.agent_id !== agentId)) return null
  let row = start
  const seen = new Set<string>()
  const lineage = [start]
  // Follow task→parent-task as well as session lineage. Background subtasks
  // deliberately have no parent_session_id (delivery and data scope differ).
  while (row.type === 'task' || row.type === 'consolidation') {
    if (seen.has(row.id) || seen.size >= 10) return null
    seen.add(row.id)
    let parentId = row.parent_session_id
    if (!parentId) {
      const edge = db.prepare(`SELECT p.session_id FROM tasks t JOIN tasks p ON p.id = t.trigger_source_id
        WHERE t.session_id = ? AND t.trigger_type = 'agent' LIMIT 1`).get(row.id) as { session_id: string | null } | undefined
      parentId = edge?.session_id ?? null
    }
    if (!parentId) break
    const parent = db.prepare('SELECT * FROM sessions WHERE id = ?').get(parentId) as ScopeRow | undefined
    if (!parent) return null
    lineage.push(parent)
    row = parent
  }
  const raw = row.session_user ?? row.user_id
  const userId = typeof raw === 'number' ? raw : /^\d+$/.test(raw ?? '') ? Number(raw) : NaN
  if (!Number.isSafeInteger(userId) || userId <= 0) return null
  for (const link of lineage) {
    const own = link.session_user ?? link.user_id
    if (own != null && String(own) !== String(userId)) return null
  }
  // Assignment is never trusted without project ownership (stale/deleted IDs fail closed).
  const projectId = row.context_policy !== 'strand-only' && row.project_id && db.prepare('SELECT 1 FROM projects WHERE id = ? AND CAST(user_id AS TEXT) = ?').get(row.project_id, String(userId))
    ? row.project_id : null
  return { userId, agentId: agentId ?? start.agent_id ?? 'main', sessionId: row.id, projectId,
    key: projectId ? `project:${projectId}` : `strand:${row.id}` }
}
/** Hash each segment: no IDs/path traversal or user names in filesystem paths. */
export function contextMemoryDir(root: string, scope: ContextScope): string {
  const segment = (s: string) => createHash('sha256').update(s).digest('hex')
  return path.join(root, 'scoped-v1', String(scope.userId), segment(scope.agentId), segment(scope.key))
}
export function contextFactPredicate(scope: ContextScope, alias = 'm'): { sql: string; params: unknown[] } {
  return { sql: `${alias}.user_id = ? AND ${alias}.agent_id = ? AND ${alias}.context_scope = ?`,
    params: [scope.userId, scope.agentId, scope.key] }
}
