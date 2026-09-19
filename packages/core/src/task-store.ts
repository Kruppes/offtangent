import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'

export type TaskStatus = 'running' | 'paused' | 'completed' | 'failed'
export type TaskTriggerType = 'user' | 'agent' | 'cronjob' | 'heartbeat' | 'consolidation'
export type TaskResultStatus = 'completed' | 'failed' | 'question' | 'silent'

export interface Task {
  id: string
  name: string
  prompt: string
  status: TaskStatus
  triggerType: TaskTriggerType
  triggerSourceId: string | null
  provider: string | null
  model: string | null
  /**
   * Whether the (provider, model) pair used to run this task came from the
   * configured task default (Settings → Tasks → Default Provider) rather than
   * an explicit override by the user or agent. `null` means the flag was not
   * recorded (legacy rows created before this column existed).
   */
  isDefaultModel: boolean | null
  maxDurationMinutes: number | null
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  toolCallCount: number
  resultSummary: string | null
  resultStatus: TaskResultStatus | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  sessionId: string | null
  agentId: string | null
  /** SPEC 11.6: JSON schema the SUMMARY must satisfy, or null. */
  outputSchema: string | null
  /** SPEC 11.6: how the delegation context was assembled. */
  contextMode: TaskContextMode | null
  /**
   * W5/P2: state this run left behind when it ended with unfinished work
   * (wrap-up, timeout, guard, error, honest failure). Null when the task
   * finished cleanly — see task-handoff.ts.
   */
  handoff: string | null
  /**
   * W5/P3: when this task's outcome was announced to its persona. Only used
   * for outcomes that never reach a strand (cronjob-triggered runs, see
   * task-agent-notice.ts); NULL means "still owed to the agent".
   */
  agentNotifiedAt: string | null
}

export type TaskContextMode = 'clean' | 'selected' | 'fork'

export interface CreateTaskInput {
  name: string
  prompt: string
  triggerType: TaskTriggerType
  triggerSourceId?: string
  provider?: string
  model?: string
  /**
   * Set to `true` when (provider, model) come from the configured task
   * default, `false` when the caller explicitly pinned a provider/model.
   * Leave unset for legacy paths that do not track this distinction.
   */
  isDefaultModel?: boolean
  maxDurationMinutes?: number
  sessionId?: string
  agentId?: string
  /** Serialised JSON schema for the SUMMARY (SPEC 11.6). */
  outputSchema?: string | null
  contextMode?: TaskContextMode | null
}

export interface UpdateTaskInput {
  status?: TaskStatus
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  cacheRead?: number
  cacheWrite?: number
  estimatedCost?: number
  toolCallCount?: number
  resultSummary?: string
  resultStatus?: TaskResultStatus
  errorMessage?: string
  startedAt?: string
  completedAt?: string
  sessionId?: string
  /** W5/P2: handoff record for unfinished work (task-handoff.ts). */
  handoff?: string | null
}

export interface TaskListFilters {
  status?: TaskStatus
  triggerType?: TaskTriggerType
  provider?: string
  model?: string
  isDefaultModel?: boolean
  createdFrom?: string
  createdTo?: string
  limit?: number
  offset?: number
}

export interface TaskFilterClauseOptions {
  includeProviderModel?: boolean
}

export interface TaskFilterClause {
  sql: string
  params: unknown[]
}

export function buildTaskFilterClause(
  filters?: TaskListFilters,
  options: TaskFilterClauseOptions = {},
): TaskFilterClause {
  const includeProviderModel = options.includeProviderModel ?? true
  let sql = ''
  const params: unknown[] = []

  if (filters?.status) {
    sql += ' AND status = ?'
    params.push(filters.status)
  }
  if (filters?.triggerType) {
    sql += ' AND trigger_type = ?'
    params.push(filters.triggerType)
  }
  if (includeProviderModel && filters?.isDefaultModel !== undefined) {
    sql += ' AND is_default_model = ?'
    params.push(filters.isDefaultModel ? 1 : 0)
  }
  if (includeProviderModel && filters?.provider) {
    sql += ' AND provider = ?'
    params.push(filters.provider)
  }
  if (includeProviderModel && filters?.model) {
    sql += ' AND model = ?'
    params.push(filters.model)
  }
  if (filters?.createdFrom) {
    sql += ' AND created_at >= ?'
    params.push(filters.createdFrom)
  }
  if (filters?.createdTo) {
    sql += ' AND created_at <= ?'
    params.push(filters.createdTo)
  }

  return { sql, params }
}

// Raw row from SQLite
interface TaskRow {
  id: string
  name: string
  prompt: string
  status: string
  trigger_type: string
  trigger_source_id: string | null
  provider: string | null
  model: string | null
  is_default_model: number | null
  max_duration_minutes: number | null
  prompt_tokens: number
  completion_tokens: number
  cache_read: number
  cache_write: number
  estimated_cost: number
  tool_call_count: number
  result_summary: string | null
  result_status: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  session_id: string | null
  agent_id: string | null
  output_schema?: string | null
  context_mode?: string | null
  handoff?: string | null
  agent_notified_at?: string | null
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    triggerType: row.trigger_type as TaskTriggerType,
    triggerSourceId: row.trigger_source_id,
    provider: row.provider,
    model: row.model,
    isDefaultModel:
      row.is_default_model === null || row.is_default_model === undefined
        ? null
        : row.is_default_model === 1,
    maxDurationMinutes: row.max_duration_minutes,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    estimatedCost: row.estimated_cost,
    toolCallCount: row.tool_call_count,
    resultSummary: row.result_summary,
    resultStatus: row.result_status as TaskResultStatus | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sessionId: row.session_id,
    agentId: row.agent_id,
    outputSchema: row.output_schema ?? null,
    contextMode: (row.context_mode as TaskContextMode | null | undefined) ?? null,
    handoff: row.handoff ?? null,
    agentNotifiedAt: row.agent_notified_at ?? null,
  }
}

/**
 * Initialize the tasks table in the database
 */
export function initTasksTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
      trigger_source_id TEXT,
      provider TEXT,
      model TEXT,
      is_default_model INTEGER,
      max_duration_minutes INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_provider_model_created_at ON tasks(provider, model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_model_created_at ON tasks(model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_is_default_model_created_at ON tasks(is_default_model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `)

  // Additive migration: add agent_id column for multi-persona task routing
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_id TEXT DEFAULT NULL`)
  } catch {
    // Column already exists — idempotent
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id)`)

  // Task tree (strand activity): `trigger_source_id` carries the delegating
  // task id for `trigger_type='agent'`, and the tree walks it generation by
  // generation with `WHERE trigger_source_id IN (…)`.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_trigger_source_id ON tasks(trigger_source_id)`)

  // Additive migration (SPEC 11.6): output contract and context mode.
  for (const stmt of [
    'ALTER TABLE tasks ADD COLUMN output_schema TEXT DEFAULT NULL',
    'ALTER TABLE tasks ADD COLUMN context_mode TEXT DEFAULT NULL',
    // W5/P2: handoff state of a run that ended with unfinished work.
    'ALTER TABLE tasks ADD COLUMN handoff TEXT DEFAULT NULL',
  ]) {
    try {
      db.exec(stmt)
    } catch {
      // Column already exists
    }
  }

  // W5/P3: announcement bookkeeping for outcomes that never reach a strand.
  // Backfilled on the ALTER so a deploy does not replay every cronjob result
  // of the last day into the agent's next turn — only runs that finish AFTER
  // the migration are owed an announcement.
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN agent_notified_at TEXT DEFAULT NULL')
    db.exec("UPDATE tasks SET agent_notified_at = COALESCE(completed_at, created_at) WHERE agent_notified_at IS NULL")
  } catch {
    // Column already exists
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_agent_notified_at ON tasks(agent_notified_at)')
}

/**
 * Task Store — CRUD operations for the tasks table
 */
export class TaskStore {
  constructor(private db: Database) {}

  /**
   * Create a new task
   */
  create(input: CreateTaskInput): Task {
    const id = randomUUID()
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    this.db.prepare(`
      INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, provider, model, is_default_model, max_duration_minutes, session_id, agent_id, output_schema, context_mode, created_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.prompt,
      input.triggerType,
      input.triggerSourceId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.isDefaultModel === undefined ? null : (input.isDefaultModel ? 1 : 0),
      input.maxDurationMinutes ?? null,
      input.sessionId ?? null,
      input.agentId ?? null,
      input.outputSchema ?? null,
      input.contextMode ?? null,
      now,
    )

    return this.getById(id)!
  }

  /**
   * Get a task by ID
   */
  getById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }

  /**
   * List tasks with optional filters
   */
  list(filters?: TaskListFilters): Task[] {
    let sql = 'SELECT * FROM tasks WHERE 1=1'
    const filterClause = buildTaskFilterClause(filters)
    sql += filterClause.sql
    const params = filterClause.params

    sql += ' ORDER BY created_at DESC'

    if (filters?.limit) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }
    if (filters?.offset) {
      sql += ' OFFSET ?'
      params.push(filters.offset)
    }

    const rows = this.db.prepare(sql).all(...params) as TaskRow[]
    return rows.map(rowToTask)
  }

  /**
   * Update a task
   */
  update(id: string, input: UpdateTaskInput): Task | null {
    const setClauses: string[] = []
    const params: unknown[] = []

    if (input.status !== undefined) {
      setClauses.push('status = ?')
      params.push(input.status)
    }
    if (input.provider !== undefined) {
      setClauses.push('provider = ?')
      params.push(input.provider)
    }
    if (input.model !== undefined) {
      setClauses.push('model = ?')
      params.push(input.model)
    }
    if (input.promptTokens !== undefined) {
      setClauses.push('prompt_tokens = ?')
      params.push(input.promptTokens)
    }
    if (input.completionTokens !== undefined) {
      setClauses.push('completion_tokens = ?')
      params.push(input.completionTokens)
    }
    if (input.cacheRead !== undefined) {
      setClauses.push('cache_read = ?')
      params.push(input.cacheRead)
    }
    if (input.cacheWrite !== undefined) {
      setClauses.push('cache_write = ?')
      params.push(input.cacheWrite)
    }
    if (input.estimatedCost !== undefined) {
      setClauses.push('estimated_cost = ?')
      params.push(input.estimatedCost)
    }
    if (input.toolCallCount !== undefined) {
      setClauses.push('tool_call_count = ?')
      params.push(input.toolCallCount)
    }
    if (input.resultSummary !== undefined) {
      setClauses.push('result_summary = ?')
      params.push(input.resultSummary)
    }
    if (input.resultStatus !== undefined) {
      setClauses.push('result_status = ?')
      params.push(input.resultStatus)
    }
    if (input.errorMessage !== undefined) {
      setClauses.push('error_message = ?')
      params.push(input.errorMessage)
    }
    if (input.startedAt !== undefined) {
      setClauses.push('started_at = ?')
      params.push(input.startedAt)
    }
    if (input.completedAt !== undefined) {
      setClauses.push('completed_at = ?')
      params.push(input.completedAt)
    }
    if (input.sessionId !== undefined) {
      setClauses.push('session_id = ?')
      params.push(input.sessionId)
    }
    if (input.handoff !== undefined) {
      setClauses.push('handoff = ?')
      params.push(input.handoff)
    }

    if (setClauses.length === 0) return this.getById(id)

    params.push(id)
    this.db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)

    return this.getById(id)
  }

  /**
   * Delete a task
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return result.changes > 0
  }
}
