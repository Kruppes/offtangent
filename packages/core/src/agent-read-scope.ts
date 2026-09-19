import { listPersonaIds } from './persona-loader.js'

/**
 * Reserved values for the optional `agent` read-scope parameter shared by
 * `search_memories` and `read_chat_history` (RC4 — cross-persona reads).
 *
 * - `'all'`    → read across every persona (no agent filter).
 * - `'shared'` → the cross-persona shared bucket (always a valid target).
 *
 * `'main'` is also always valid: it is the orchestrator and has no persona
 * directory, but its rows are labelled `agent_id = 'main'`.
 */
export const READ_SCOPE_ALL = 'all'

export interface ResolveAgentScopeOptions {
  /** The `agent` parameter value supplied by the caller (may be undefined). */
  requested: string | undefined
  /** The persona the calling runtime belongs to (getCurrentAgentId()). */
  callerAgentId: string | undefined
  /**
   * Injectable list of known persona ids (excludes 'main'). Defaults to the
   * on-disk persona directories via listPersonaIds(). Injectable for tests.
   */
  listAgentIds?: () => string[]
}

export type ResolveAgentScopeResult =
  | {
      ok: true
      /**
       * The concrete agentId to scope to, or `undefined` for "no agent filter".
       *   - undefined → unscoped (default for 'main'; also `agent: "all"`)
       *   - string    → scope to that bucket
       */
      agentId: string | undefined
      /**
       * Whether the caller explicitly requested a cross-persona scope via the
       * `agent` parameter. False for the default (no-param) path. Lets callers
       * preserve their exact legacy default filter while opting into a
       * '+shared' widening only for explicit requests.
       */
      explicit: boolean
    }
  | { ok: false; error: string }

/**
 * Resolve the effective agent read-scope for a memory/chat-history tool call.
 *
 * Precedence:
 *  1. No `agent` param → today's behaviour: 'main' (and legacy callers with
 *     no callerAgentId) are unscoped; every other persona is locked to its
 *     own bucket + 'shared'.
 *  2. `agent: "all"` → unscoped (read across all personas).
 *  3. `agent: "<id>"` → scope to exactly that bucket (+ 'shared'), after
 *     validating the id against the set of known personas. Unknown ids yield
 *     an explicit error (never a silent empty result).
 *
 * User-id scoping is a separate axis and is intentionally untouched here.
 */
export function resolveAgentReadScope(options: ResolveAgentScopeOptions): ResolveAgentScopeResult {
  const requested = options.requested?.trim()

  // 1. Default: no explicit request — preserve legacy per-persona scoping.
  if (requested === undefined || requested.length === 0) {
    const callerAgentId = options.callerAgentId
    const agentId = callerAgentId && callerAgentId !== 'main' ? callerAgentId : undefined
    return { ok: true, agentId, explicit: false }
  }

  // 2. Explicit "all" — read across every persona.
  if (requested === READ_SCOPE_ALL) {
    return { ok: true, agentId: undefined, explicit: true }
  }

  // 3. Explicit concrete id — validate against known personas.
  const personaIds = (options.listAgentIds ?? listPersonaIds)()
  const known = new Set<string>(['main', 'shared', ...personaIds])
  if (!known.has(requested)) {
    const validList = ['all', 'main', 'shared', ...personaIds.filter(id => id !== 'main')]
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ')
    return {
      ok: false,
      error:
        `Error: unknown agent "${requested}". Valid values: ${validList}. ` +
        `Use "all" to read across every persona.`,
    }
  }

  return { ok: true, agentId: requested, explicit: true }
}
