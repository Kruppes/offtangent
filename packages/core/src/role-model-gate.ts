/**
 * role-model-gate.ts: resolving ONE model-policy spec and running it through
 * the data-policy gate.
 *
 * This lives in its own module on purpose. `model-policy.ts` (the reader of
 * `modelPolicy.roles`) imports `task-model-policy.ts`, so the task roles
 * cannot import back from `model-policy.ts` without a cycle — while both need
 * exactly the same two steps before a background job may use a model:
 *
 *   1. resolve the spec (`providerId:modelId`, a bare model id, a provider)
 *      against `providers.json`
 *   2. ask the ONE gate of `data-policy.ts` whether an AUTOMATIC choice may
 *      send private data there (D7)
 *
 * `model-policy.ts` re-exports both functions, so the public surface of the
 * package does not change.
 */
import { checkAutomaticModel, type GateDecision } from './data-policy.js'
import { resolveProviderModelInput } from './provider-config.js'

export interface ResolvedRoleModel {
  providerId: string
  providerName: string
  modelId: string
}

export type SpecResolution =
  | ({ ok: true } & ResolvedRoleModel)
  | { ok: false; error: string }

/**
 * Resolve ONE spec entry (`providerId:modelId`, `Name:modelId`, a bare model
 * id or a bare provider) against `providers.json`. Splits at the FIRST colon
 * so model ids that carry colons (`qwen3.8:27b-mlx`) survive.
 */
export function resolveModelPolicySpec(spec: string): SpecResolution {
  const trimmed = spec.trim()
  if (!trimmed) return { ok: false, error: 'empty spec' }
  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const hit = resolveProviderModelInput({
      provider: trimmed.slice(0, colon),
      model: trimmed.slice(colon + 1),
    })
    if (hit.ok) return hit
    // A bare model id may itself contain a colon (`qwen3.8:27b-mlx`).
    const asModel = resolveProviderModelInput({ model: trimmed })
    return asModel.ok ? asModel : { ok: false, error: hit.error }
  }
  const hit = resolveProviderModelInput({ model: trimmed })
  if (hit.ok) return hit
  const asProvider = resolveProviderModelInput({ provider: trimmed })
  return asProvider.ok ? asProvider : { ok: false, error: hit.error }
}

export interface RoleGateResult {
  /** The spec the consumer should use, `''` when the gate dropped it. */
  spec: string
  /** `null` when the spec does not resolve to a provider/model at all. */
  decision: GateDecision | null
}

/**
 * Run ONE spec of a background role through the data-policy gate
 * (D7: every AUTOMATIC model choice passes here).
 *
 * The result is the spec itself when it may be used, and `''` when the gate
 * dropped it — `''` is what every consumer already understands as "no role
 * model configured, keep the active provider", so a rejected role degrades
 * exactly like an unset one instead of crashing a background job.
 *
 * A spec that does not resolve to a configured provider is passed through
 * untouched: resolving it is the consumer's problem, and was before. The same
 * holds when `providers.json` cannot be read at all — the gate never turns a
 * broken config into a second failure mode, the consumer's own resolution
 * step fails right after with the real error.
 */
export function gateRoleSpec(role: string, spec: string): RoleGateResult {
  const trimmed = spec.trim()
  if (!trimmed) return { spec: '', decision: null }
  let hit: SpecResolution
  try {
    hit = resolveModelPolicySpec(trimmed)
  } catch {
    return { spec: trimmed, decision: null }
  }
  if (!hit.ok) return { spec: trimmed, decision: null }
  const decision = checkAutomaticModel(hit.providerId, hit.modelId, role)
  if (decision.allowed) return { spec: trimmed, decision }
  console.warn(
    `[model-policy] Role "${role}" entry "${trimmed}" is blocked by the data policy `
    + `(${decision.reason}), falling back to the active provider`,
  )
  return { spec: '', decision }
}

/**
 * Role suffix of an audit entry written for a FALLBACK choice, so the audit
 * log distinguishes "the configured role model was blocked" from "the job
 * silently used whatever the chat is pointed at".
 */
export const FALLBACK_AUDIT_SUFFIX = 'fallback:active_provider'

export interface FallbackGateResult {
  /** May the job run on this provider/model? */
  allowed: boolean
  /** `null` only when the gate itself threw (treated as blocked). */
  decision: GateDecision | null
  /** Machine-readable reason, also written to the audit ring. */
  reason: string
}

/**
 * Gate the FALLBACK of a background job to the ACTIVE chat provider
 * (plan 2026-09-26, F3 of the review triage 19:25).
 *
 * `gateRoleSpec` drops a role model the data policy forbids and returns `''`,
 * which every consumer reads as "no role model configured" — and then falls
 * back to the active chat provider WITHOUT asking the gate. A user who points
 * the chat at a blocked family therefore had every background job (session
 * summary, fact extraction, consolidation, plan verification) send the whole
 * conversation there.
 *
 * A fallback is an AUTOMATIC choice (D7), so it passes the same gate. When it
 * is blocked the caller must SKIP the job — never switch to some other model
 * on its own, because nobody asked for that endpoint either. In `audit` mode
 * the run is allowed and recorded, like everywhere else; in `off` mode the
 * gate is inactive and everything passes.
 *
 * The audit entry is filed under `<role>:fallback:active_provider`.
 */
export function gateFallbackModel(
  role: string,
  providerId: string,
  modelId: string,
  options: Parameters<typeof checkAutomaticModel>[3] = {},
): FallbackGateResult {
  const auditRole = `${role}:${FALLBACK_AUDIT_SUFFIX}`
  let decision: GateDecision
  try {
    decision = checkAutomaticModel(providerId, modelId, auditRole, options)
  } catch (err) {
    // Fail closed: if the gate cannot judge the endpoint, the job does not run.
    console.warn(
      `[model-policy] Fallback gate for role "${role}" could not evaluate ${providerId}/${modelId}: `
      + `${(err as Error)?.message ?? 'unknown error'} — skipping the job`,
    )
    return { allowed: false, decision: null, reason: 'blocked:gate_error' }
  }
  if (!decision.allowed) {
    console.warn(
      `[model-policy] Role "${role}" has no own model and the active provider ${providerId} (${modelId}) `
      + `is blocked by the data policy (${decision.reason}, mode ${decision.mode}) — skipping the job`,
    )
  } else if (!decision.policyAllows) {
    console.warn(
      `[model-policy] Role "${role}" falls back to the active provider ${providerId} (${modelId}), `
      + `which the data policy would block (${decision.reason}) — allowed in mode ${decision.mode}, recorded`,
    )
  }
  return { allowed: decision.allowed, decision, reason: decision.reason }
}
