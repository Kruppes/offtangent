import { createHmac, randomBytes } from 'node:crypto'
import { loadConfig } from './config.js'
import type { Database } from './database.js'
import { splitSystemPromptAtCacheMarker } from './prompt-cache.js'
import { stripStrandContextFromLastUserMessage } from './strand-context.js'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

/**
 * Content-free cache-cause probe, one row per model request of a runtime
 * (one content-free row per completed model request).
 *
 * The row records candidate changes, not a unique cause of a rewrite:
 * strand trim, changed tool block, changed system prompt before or after the
 * cache marker, another history change, or none of these. It stores only
 * counters, lengths, timestamps, ids and keyed checksums over whole blocks;
 * never prompt or message text, file names, tool names or tool arguments.
 *
 * Measuring never changes the request and never throws into the turn: every
 * failure is swallowed and counted in {@link requestProbeErrorCount}.
 */

export type RequestProbeTurnKind = 'interactive' | 'task_injection' | 'other'

/** What agent.ts knows about the turn before the runtime sends it. */
export interface RequestProbeHint {
  turnKind: RequestProbeTurnKind
  /** Messages the strand trim removed before this turn. */
  trimDropped?: number
  /** True when the trim put an opener user message in front of the window. */
  trimRepaired?: boolean
  /** Token budget of the strand window and the visible estimate kept after the trim. */
  trimBudgetTokens?: number
  trimKeptTokens?: number
  /** Length of the `<strand_context>` block prepended to the user text. */
  digestChars?: number
}

export interface RequestProbeSettings {
  enabled: boolean
  retentionDays: number
}

export const DEFAULT_REQUEST_PROBE_SETTINGS: RequestProbeSettings = { enabled: true, retentionDays: 60 }

export function resolveRequestProbeSettings(raw: unknown): RequestProbeSettings {
  const out = { ...DEFAULT_REQUEST_PROBE_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as { enabled?: unknown; retentionDays?: unknown }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.retentionDays === 'number' && Number.isFinite(r.retentionDays)) {
    out.retentionDays = Math.min(365, Math.max(1, Math.round(r.retentionDays)))
  }
  return out
}

/** `settings.json` → `requestProbe`. Unreadable settings keep the defaults. */
export function loadRequestProbeSettings(): RequestProbeSettings {
  try {
    const settings = loadConfig<{ requestProbe?: unknown }>('settings.json')
    return resolveRequestProbeSettings(settings?.requestProbe)
  } catch {
    return { ...DEFAULT_REQUEST_PROBE_SETTINGS }
  }
}

/** Blocks shorter than this get no checksum, only their length. */
export const MIN_HASHED_CHARS = 64
/** Rows written between two retention sweeps. */
const PRUNE_EVERY = 500
/** Sessions whose last message checksums are kept in memory. */
const MAX_TRACKED_SESSIONS = 64

let errorCount = 0
let warned = false
let droppedCount = 0

/** Swallowed probe failures since process start (diagnostics, tests). */
export function requestProbeErrorCount(): number {
  return errorCount
}

/** Measured requests that never reached `message_end` (aborted before the stream). */
export function requestProbeDroppedCount(): number {
  return droppedCount
}

/** Test seam. */
export function resetRequestProbeCounters(): void {
  errorCount = 0
  droppedCount = 0
  warned = false
}

function swallow(_err: unknown): void {
  errorCount++
  if (!warned) {
    warned = true
    // Class only: an error message could echo a value.
    console.warn("[request-probe] measurement failed and was skipped; further failures are only counted")
  }
}

const schemaReady = new WeakSet<object>()

/** Additive, idempotent: two new tables, nothing else touched. */
export function ensureRequestProbeSchema(db: Database): void {
  if (schemaReady.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      usage_id INTEGER,
      session_id TEXT,
      agent_id TEXT,
      turn_kind TEXT NOT NULL,
      turn_seq INTEGER NOT NULL,
      trim_dropped INTEGER,
      trim_repaired INTEGER,
      trim_budget_tokens INTEGER,
      trim_kept_tokens INTEGER,
      digest_chars INTEGER,
      tools_count INTEGER NOT NULL,
      tools_chars INTEGER NOT NULL,
      tools_hash TEXT,
      sys_marker INTEGER NOT NULL,
      sys_pre_chars INTEGER NOT NULL,
      sys_pre_hash TEXT,
      sys_post_chars INTEGER NOT NULL,
      sys_post_hash TEXT,
      msg_count INTEGER NOT NULL,
      history_chars INTEGER NOT NULL,
      new_msg_chars INTEGER NOT NULL,
      prev_msg_count INTEGER,
      history_kept_msgs INTEGER,
      history_kept_chars INTEGER,
      first_difference TEXT,
      context_kept_msgs INTEGER,
      context_kept_chars INTEGER,
      shifted_msgs INTEGER,
      shifted_kept_msgs INTEGER,
      shifted_kept_chars INTEGER,
      est_sys_tokens INTEGER NOT NULL,
      est_tools_tokens INTEGER NOT NULL,
      est_history_tokens INTEGER NOT NULL,
      est_new_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_probe_session ON request_probe(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_request_probe_usage ON request_probe(usage_id);
    CREATE INDEX IF NOT EXISTS idx_request_probe_created ON request_probe(created_at);
    CREATE TABLE IF NOT EXISTS request_probe_key (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret TEXT NOT NULL
    );
  `)
  // Existing first-build tables are upgraded without a rebuild.
  const columns = new Set((db.prepare('PRAGMA table_info(request_probe)').all() as Array<{ name: string }>).map(c => c.name))
  for (const column of ['history_kept_chars', 'first_difference', 'context_kept_msgs', 'context_kept_chars', 'shifted_msgs', 'shifted_kept_msgs', 'shifted_kept_chars']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE request_probe ADD COLUMN ${column} ${column === 'first_difference' ? 'TEXT' : 'INTEGER'}`)
  }
  schemaReady.add(db)
}

const keyCache = new WeakMap<object, Buffer>()

function installKey(db: Database): Buffer {
  const cached = keyCache.get(db)
  if (cached) return cached
  db.prepare('INSERT OR IGNORE INTO request_probe_key (id, secret) VALUES (1, ?)').run(randomBytes(32).toString('hex'))
  const row = db.prepare('SELECT secret FROM request_probe_key WHERE id = 1').get() as { secret: string }
  const key = Buffer.from(row.secret, 'hex')
  keyCache.set(db, key)
  return key
}

function keyedHash(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex').slice(0, 16)
}

/** Checksum of a whole block, or null when the block is too short to hide its content. */
function blockHash(key: Buffer, text: string): string | null {
  return text.length >= MIN_HASHED_CHARS ? keyedHash(key, text) : null
}

function estTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** The measured, content-free shape of one request (exported for tests). */
export interface RequestProbeRow {
  session_id: string | null
  agent_id: string | null
  turn_kind: RequestProbeTurnKind
  turn_seq: number
  trim_dropped: number | null
  trim_repaired: number | null
  trim_budget_tokens: number | null
  trim_kept_tokens: number | null
  digest_chars: number | null
  tools_count: number
  tools_chars: number
  tools_hash: string | null
  sys_marker: number
  sys_pre_chars: number
  sys_pre_hash: string | null
  sys_post_chars: number
  sys_post_hash: string | null
  msg_count: number
  history_chars: number
  new_msg_chars: number
  prev_msg_count: number | null
  history_kept_msgs: number | null
  history_kept_chars: number | null
  first_difference: 'first' | 'prefix' | 'shifted' | 'context_removed' | 'changed'
  context_kept_msgs: number | null
  context_kept_chars: number | null
  shifted_msgs: number | null
  shifted_kept_msgs: number | null
  shifted_kept_chars: number | null
  est_sys_tokens: number
  est_tools_tokens: number
  est_history_tokens: number
  est_new_tokens: number
}

interface RequestContextLike {
  systemPrompt?: unknown
  messages?: unknown
  tools?: unknown
}

/**
 * One recorder per runtime. Call order per turn: `beginTurn` (once), then per
 * request `observe` (before sending) and `commit` (after the usage row).
 */
export class RequestProbeRecorder {
  private hint: RequestProbeHint | null = null
  private turn: { hint: RequestProbeHint; seq: number; settings: RequestProbeSettings } | null = null
  private pending: RequestProbeRow | null = null
  private lastMessages = new Map<string, { hashes: string[]; lengths: number[]; stripped: Map<number, string> }>()
  private writesSincePrune = -1

  constructor(
    private readonly getDb: () => Database | null | undefined,
    private readonly getAgentId: () => string | null,
    private readonly loadSettings: () => RequestProbeSettings = loadRequestProbeSettings,
  ) {}

  /** Set by agent.ts right before the turn; consumed by the next `beginTurn`. */
  setHint(hint: RequestProbeHint): void {
    this.hint = hint
  }

  /**
   * Start of a run. An internal retry of the same turn (`continueRun`) keeps
   * the hint and the request counter of the turn it repeats.
   */
  beginTurn(continueRun = false): void {
    if (continueRun && this.turn) return
    try {
      const hint = this.hint ?? { turnKind: 'other' as const }
      this.hint = null
      this.turn = { hint, seq: 0, settings: this.loadSettings() }
    } catch (err) {
      this.turn = null
      swallow(err)
    }
  }

  /** Measure one outgoing request. Never modifies `context`, never throws. */
  observe(sessionId: string | null | undefined, context: unknown): void {
    try {
      if (this.pending) {
        droppedCount++
        this.pending = null
      }
      const turn = this.turn
      if (!turn || !turn.settings.enabled) return
      const db = this.getDb()
      if (!db) return
      ensureRequestProbeSchema(db)
      const key = installKey(db)
      const ctx = (context ?? {}) as RequestContextLike
      const seq = turn.seq++

      const tools = Array.isArray(ctx.tools) ? ctx.tools : []
      const toolsJson = safeJson(tools.map(t => {
        const tool = (t ?? {}) as { name?: unknown; description?: unknown; parameters?: unknown }
        return { name: tool.name, description: tool.description, parameters: tool.parameters }
      }))

      const rawPrompt = typeof ctx.systemPrompt === 'string' ? ctx.systemPrompt : ''
      const split = splitSystemPromptAtCacheMarker(rawPrompt)
      const pre = split.prefixChars === null ? '' : split.text.slice(0, split.prefixChars)
      const post = split.prefixChars === null ? split.text : split.text.slice(split.prefixChars)

      const messages = Array.isArray(ctx.messages) ? ctx.messages : []
      const perMessage = messages.map(m => safeJson(m))
      const lengths = perMessage.map(s => s.length)
      const total = lengths.reduce((a, b) => a + b, 0)
      const newChars = lengths.length > 0 ? lengths[lengths.length - 1]! : 0
      const historyChars = total - newChars
      const hashes = perMessage.map(s => keyedHash(key, s))

      const sessionKey = sessionId ?? ''
      const prev = this.lastMessages.get(sessionKey)
      let kept: number | null = null
      let keptChars: number | null = null
      let difference: RequestProbeRow['first_difference'] = 'first'
      let contextKept: number | null = null
      let contextChars: number | null = null
      let shifted: number | null = null
      let shiftedKept: number | null = null
      let shiftedChars: number | null = null
      if (prev) {
        kept = 0
        while (kept < prev.hashes.length && kept < hashes.length && prev.hashes[kept] === hashes[kept]) kept++
        keptChars = lengths.slice(0, kept).reduce((a, b) => a + b, 0)
        difference = kept === prev.hashes.length ? 'prefix' : 'changed'
        if (kept < prev.hashes.length && prev.stripped.get(kept) === hashes[kept]) {
          difference = 'context_removed'
          contextKept = kept + 1
          while (contextKept < prev.hashes.length && contextKept < hashes.length && prev.hashes[contextKept] === hashes[contextKept]) contextKept++
          contextChars = lengths.slice(0, contextKept).reduce((a, b) => a + b, 0)
        }
        // A repaired opener can stay byte-identical while the following window
        // shifts. Search every positive offset, not just a mismatch at index 0.
        // Require two consecutive anchored messages to avoid attributing a
        // coincidentally equal opener alone to a moved cut.
        for (let start = 0; start <= kept; start++) {
          for (let offset = start + 1; offset < prev.hashes.length; offset++) {
            let n = 0
            while (offset + n < prev.hashes.length && start + n < hashes.length &&
                   (prev.hashes[offset + n] === hashes[start + n] || prev.stripped.get(offset + n) === hashes[start + n])) n++
            if (n >= 2 && (shiftedKept === null || start + n > shiftedKept)) {
              if (prev.stripped.get(offset) === hashes[start]) {
                contextKept = start + n
                contextChars = lengths.slice(0, start + n).reduce((a, b) => a + b, 0)
              }
              shifted = offset - start
              shiftedKept = start + n
              shiftedChars = lengths.slice(0, start + n).reduce((a, b) => a + b, 0)
            }
          }
        }
        if (shifted !== null) difference = 'shifted'
      }
      const stripped = new Map<number, string>()
      const cleaned = stripStrandContextFromLastUserMessage(messages as AgentMessage[])
      if (cleaned) {
        for (let i = 0; i < messages.length; i++) {
          const cleanedHash = keyedHash(key, safeJson(cleaned[i]))
          if (cleanedHash !== hashes[i]) stripped.set(i, cleanedHash)
        }
      }
      this.lastMessages.delete(sessionKey)
      this.lastMessages.set(sessionKey, { hashes, lengths, stripped })
      while (this.lastMessages.size > MAX_TRACKED_SESSIONS) {
        const oldest = this.lastMessages.keys().next().value
        if (oldest === undefined) break
        this.lastMessages.delete(oldest)
      }

      const first = seq === 0
      const h = turn.hint
      this.pending = {
        session_id: sessionId ?? null,
        agent_id: this.getAgentId(),
        turn_kind: h.turnKind,
        turn_seq: seq,
        // Trim and digest belong to the turn start; follow-up requests of the
        // tool loop carry NULL so a sum over a turn does not count them twice.
        trim_dropped: first && h.trimDropped !== undefined ? h.trimDropped : null,
        trim_repaired: first && h.trimRepaired !== undefined ? (h.trimRepaired ? 1 : 0) : null,
        trim_budget_tokens: first && h.trimBudgetTokens !== undefined ? h.trimBudgetTokens : null,
        trim_kept_tokens: first && h.trimKeptTokens !== undefined ? h.trimKeptTokens : null,
        digest_chars: first && h.digestChars !== undefined ? h.digestChars : null,
        tools_count: tools.length,
        tools_chars: toolsJson.length,
        tools_hash: blockHash(key, toolsJson),
        sys_marker: split.prefixChars === null ? 0 : 1,
        sys_pre_chars: pre.length,
        sys_pre_hash: blockHash(key, pre),
        sys_post_chars: post.length,
        sys_post_hash: blockHash(key, post),
        msg_count: messages.length,
        history_chars: historyChars,
        new_msg_chars: newChars,
        prev_msg_count: prev ? prev.hashes.length : null,
        history_kept_msgs: kept,
        history_kept_chars: keptChars,
        first_difference: difference,
        context_kept_msgs: contextKept,
        context_kept_chars: contextChars,
        shifted_msgs: shifted,
        shifted_kept_msgs: shiftedKept,
        shifted_kept_chars: shiftedChars,
        est_sys_tokens: estTokens(split.text.length),
        est_tools_tokens: estTokens(toolsJson.length),
        est_history_tokens: estTokens(historyChars),
        est_new_tokens: estTokens(newChars),
      }
    } catch (err) {
      this.pending = null
      swallow(err)
    }
  }

  /** Write the pending row, linked to the `token_usage` row of the same request. */
  commit(usageId: number | null | undefined): void {
    const row = this.pending
    this.pending = null
    if (!row) return
    try {
      const db = this.getDb()
      if (!db) return
      ensureRequestProbeSchema(db)
      const cols = Object.keys(row) as Array<keyof RequestProbeRow>
      db.prepare(
        `INSERT INTO request_probe (usage_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      ).run(typeof usageId === 'number' && Number.isFinite(usageId) ? usageId : null, ...cols.map(c => row[c]))
      this.maybePrune(db)
    } catch (err) {
      swallow(err)
    }
  }

  /** Test seam: the row `commit` would write next. */
  peekPending(): RequestProbeRow | null {
    return this.pending
  }

  private maybePrune(db: Database): void {
    this.writesSincePrune++
    if (this.writesSincePrune !== 0 && this.writesSincePrune < PRUNE_EVERY) return
    this.writesSincePrune = 0
    const days = this.turn?.settings.retentionDays ?? DEFAULT_REQUEST_PROBE_SETTINGS.retentionDays
    pruneRequestProbes(db, days)
  }
}

/** Delete rows older than `retentionDays`. Returns the number of deleted rows. */
export function pruneRequestProbes(db: Database, retentionDays: number): number {
  ensureRequestProbeSchema(db)
  const days = Math.min(365, Math.max(1, Math.round(retentionDays)))
  const res = db.prepare(`DELETE FROM request_probe WHERE created_at < datetime('now', ?)`).run(`-${days} days`)
  return Number(res.changes ?? 0)
}
