/**
 * strand-turns.ts: exact turn bookkeeping for the strand statistics
 * (Offtangent context panel, phase B).
 *
 * Before this table existed a "turn" could only be reconstructed from message
 * timestamps (user prompt → last assistant/tool row before the next trigger),
 * which is why the statistics mark everything older as `estimated`. From now on
 * every turn the {@link TurnRunner} drives writes one `strand_turns` row:
 * started_at when the runner picks it up, first_token_at on the first streamed
 * chunk, ended_at + status when it finishes. `token_usage` and `tool_calls`
 * rows written while the turn is active carry its `turn_id`.
 *
 * Everything here is additive: new table, nullable columns, no backfill of
 * history (old rows keep `turn_id = NULL` and stay estimated). Writing never
 * throws — the statistics must never break the turn they observe.
 */
import type { Database } from './database.js'

export type StrandTurnTrigger = 'user' | 'task_injection' | 'system'
export type StrandTurnInputMode = 'typed' | 'voice' | 'answer'
export type StrandTurnStatus = 'running' | 'completed' | 'failed' | 'aborted'

/** How a usage row is paid: an OAuth subscription, metered API billing, or a local model. */
export type BillingKind = 'subscription' | 'metered' | 'local'

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
}

/**
 * Idempotent migration for the strand statistics. Safe on every start:
 *  - `strand_turns` (new table)
 *  - `token_usage`: turn_id, billing, agent_id, context_window, error
 *  - `tool_calls`: turn_id, is_internal
 *  - `persona_delegations`: origin_session_id (the strand an ask_agent came from)
 */
export function ensureStrandStatsSchema(db: Database, internalToolNames: Iterable<string> = []): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strand_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      trigger TEXT NOT NULL DEFAULT 'user',
      input_mode TEXT,
      started_at TEXT NOT NULL,
      first_token_at TEXT,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE INDEX IF NOT EXISTS idx_strand_turns_session ON strand_turns(session_id, started_at);
  `)

  const tu = columnNames(db, 'token_usage')
  if (!tu.has('turn_id')) db.exec('ALTER TABLE token_usage ADD COLUMN turn_id TEXT')
  if (!tu.has('billing')) db.exec('ALTER TABLE token_usage ADD COLUMN billing TEXT')
  if (!tu.has('agent_id')) db.exec('ALTER TABLE token_usage ADD COLUMN agent_id TEXT')
  if (!tu.has('context_window')) db.exec('ALTER TABLE token_usage ADD COLUMN context_window INTEGER')
  if (!tu.has('error')) db.exec('ALTER TABLE token_usage ADD COLUMN error TEXT')

  const tc = columnNames(db, 'tool_calls')
  if (!tc.has('turn_id')) db.exec('ALTER TABLE tool_calls ADD COLUMN turn_id TEXT')
  if (!tc.has('is_internal')) {
    db.exec('ALTER TABLE tool_calls ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0')
    // One-time backfill when the column is first added: the internal metric
    // rows are identified by name (the same list readers filtered on so far).
    const names = [...internalToolNames]
    if (names.length > 0) {
      db.prepare(`UPDATE tool_calls SET is_internal = 1 WHERE tool_name IN (${names.map(() => '?').join(',')})`).run(...names)
    }
  }

  const pd = columnNames(db, 'persona_delegations')
  if (pd.size > 0 && !pd.has('origin_session_id')) db.exec('ALTER TABLE persona_delegations ADD COLUMN origin_session_id TEXT')

  // The stats endpoint walks a strand's task tree; these keep that walk on
  // indexes instead of table scans. Additive and idempotent.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_turn ON token_usage(turn_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
  `)
}

// ---------------------------------------------------------------------------
// Active turn registry: logTokenUsage/logToolCall look up the running turn of
// a session here, so the turn id reaches every row without threading it
// through every call site.

const activeTurns = new Map<string, string>()

export function setActiveStrandTurn(sessionId: string, turnId: string): void {
  activeTurns.set(sessionId, turnId)
}

export function clearActiveStrandTurn(sessionId: string, turnId: string): void {
  if (activeTurns.get(sessionId) === turnId) activeTurns.delete(sessionId)
}

export function activeStrandTurnId(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  return activeTurns.get(sessionId) ?? null
}

function nowIso(): string {
  return new Date().toISOString()
}

export interface StartStrandTurnInput {
  id: string
  sessionId: string
  agentId?: string
  trigger?: StrandTurnTrigger
  inputMode?: StrandTurnInputMode | null
  startedAt?: string
}

export function recordStrandTurnStart(db: Database | null | undefined, input: StartStrandTurnInput): void {
  if (!db) return
  try {
    db.prepare(`
      INSERT OR IGNORE INTO strand_turns (id, session_id, agent_id, trigger, input_mode, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(input.id, input.sessionId, input.agentId ?? 'main', input.trigger ?? 'user', input.inputMode ?? null, input.startedAt ?? nowIso())
    setActiveStrandTurn(input.sessionId, input.id)
  } catch (err) {
    console.warn('[strand-turns] could not record turn start:', (err as Error).message)
  }
}

/** Sets first_token_at once; later calls are no-ops. */
export function recordStrandTurnFirstToken(db: Database | null | undefined, turnId: string, at: string = nowIso()): void {
  if (!db) return
  try {
    db.prepare('UPDATE strand_turns SET first_token_at = ? WHERE id = ? AND first_token_at IS NULL').run(at, turnId)
  } catch (err) {
    console.warn('[strand-turns] could not record first token:', (err as Error).message)
  }
}

export function recordStrandTurnEnd(db: Database | null | undefined, turnId: string, sessionId: string, status: Exclude<StrandTurnStatus, 'running'>, at: string = nowIso()): void {
  clearActiveStrandTurn(sessionId, turnId)
  if (!db) return
  try {
    db.prepare('UPDATE strand_turns SET ended_at = ?, status = ? WHERE id = ? AND ended_at IS NULL').run(at, status, turnId)
  } catch (err) {
    console.warn('[strand-turns] could not record turn end:', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Billing mapping. Configurable, not hard-wired: the defaults describe the
// common case (OAuth subscription providers, local runners); an install
// overrides or extends them with `OFFTANGENT_BILLING_MAP` (JSON object
// provider → subscription|metered|local) or {@link configureBillingMapping}.
// Unknown providers are `metered`.

export const DEFAULT_BILLING_MAPPING: Readonly<Record<string, BillingKind>> = Object.freeze({
  'anthropic': 'subscription',
  'openai-codex': 'subscription',
  'github-copilot': 'subscription',
  'ollama': 'local',
  'ollama-native': 'local',
  'lmstudio': 'local',
  'llama-cpp': 'local',
  'image-generation': 'metered',
})

let billingOverrides: Record<string, BillingKind> | null = null

function isBillingKind(v: unknown): v is BillingKind {
  return v === 'subscription' || v === 'metered' || v === 'local'
}

function envOverrides(): Record<string, BillingKind> {
  const raw = process.env.OFFTANGENT_BILLING_MAP
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, BillingKind> = {}
    for (const [k, v] of Object.entries(parsed ?? {})) if (isBillingKind(v)) out[k] = v
    return out
  } catch {
    console.warn('[strand-turns] OFFTANGENT_BILLING_MAP is not valid JSON; ignored')
    return {}
  }
}

/** Replace the configured overrides (null resets to defaults + env). */
export function configureBillingMapping(overrides: Record<string, BillingKind> | null): void {
  billingOverrides = overrides
}

/** The effective provider → billing mapping (defaults, then env, then configured overrides). */
export function billingMapping(): Record<string, BillingKind> {
  return { ...DEFAULT_BILLING_MAPPING, ...envOverrides(), ...(billingOverrides ?? {}) }
}

export function billingForProvider(provider: string | null | undefined, mapping: Record<string, BillingKind> = billingMapping()): BillingKind {
  if (!provider) return 'metered'
  return mapping[provider] ?? 'metered'
}
