/**
 * model-policy.ts: one reader for the whole `modelPolicy.roles` block
 * (ADR 2026-09-13 "Modell-Policy für Offtangent").
 *
 * The policy is a single declarative document in `settings.json`:
 *
 *   "modelPolicy": {
 *     "roles": {
 *       "router":             "claude-sonnet-5-5, claude-sonnet-5, gpt-5.4-nano:0.9, ministral-3:14b",
 *       "projectAssignment":  "<providerId>:<modelId>, <providerId>:<modelId>",
 *       "speechSummary":      "<providerId>:<modelId>",
 *       "task:cronjob":       "<providerId>:<modelId>",
 *       "consolidation":      "<providerId>:<modelId>"
 *     }
 *   }
 *
 * Two rules this module encodes, both from the ADR:
 *
 * 1. **`default` is not part of the document.** It is derived from
 *    `providers.json` (active provider/model), served read-only and rejected
 *    on write. Two writable truths for the active model is exactly the
 *    confusion the policy abolishes.
 * 2. **Migration by read-through.** The legacy per-feature fields
 *    (`sessionSummaryProviderId`, `factExtraction.providerId`,
 *    `memoryConsolidation.providerId`, `stt.rewrite.providerId`,
 *    `tasks.loopDetection.smartProvider`) stay on disk and keep being read as
 *    long as the corresponding role is empty. No rewrite on start, rollback
 *    stays possible.
 *
 * `resolveRoleProvider()` is the ONE function every consumer of a background
 * role goes through, so "role beats legacy field beats active provider" is
 * implemented once instead of five times.
 */
import { loadConfig, warnConfigReadFailed } from './config.js'
import { CN_PROVIDER_TYPES } from './data-policy.js'
import { loadProvidersDecrypted } from './provider-config.js'
import { gateRoleSpec, type ResolvedRoleModel } from './role-model-gate.js'
import { TASK_MODEL_ROLE_KINDS } from './task-model-policy.js'

/** Roles whose value is an ordered chain (`a, b:0.9, c`), not a single entry. */
export const MODEL_POLICY_CHAIN_ROLES = ['router', 'projectAssignment'] as const

export type ModelPolicyChainRole = (typeof MODEL_POLICY_CHAIN_ROLES)[number]

export function isChainRole(role: string): role is ModelPolicyChainRole {
  return (MODEL_POLICY_CHAIN_ROLES as readonly string[]).includes(role)
}

/**
 * Legacy settings fields a role reads through to while the role itself is
 * empty. Dotted paths into `settings.json`.
 */
export const MODEL_POLICY_LEGACY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  summary: 'sessionSummaryProviderId',
  factExtraction: 'factExtraction.providerId',
  consolidation: 'memoryConsolidation.providerId',
  sttRewrite: 'stt.rewrite.providerId',
  loopDetection: 'tasks.loopDetection.smartProvider',
})

/** Roles that take exactly one entry (no chain, no threshold). */
export const MODEL_POLICY_SINGLE_ROLES: readonly string[] = Object.freeze([
  'speechSummary',
  // One-time strand model pin backfill (strand isolation goal 3): which model
  // strands that predate pin-on-create are pinned to when their persona has no
  // pin of its own. Read by `resolveBackfillStrandModel`.
  'strandBackfill',
  ...Object.keys(MODEL_POLICY_LEGACY_FIELDS),
  'task:default',
  ...TASK_MODEL_ROLE_KINDS.map(kind => `task:${kind}`),
])

/** Every role name the API knows, chain roles first. */
export const MODEL_POLICY_ROLES: readonly string[] = Object.freeze([
  ...MODEL_POLICY_CHAIN_ROLES,
  ...MODEL_POLICY_SINGLE_ROLES,
])

/** `default` is derived from providers.json and never written here. */
export const MODEL_POLICY_READ_ONLY_ROLE = 'default'

export type ModelPolicyRoleSource = 'role' | 'legacy' | 'active'

export interface RoleProviderHit {
  role: string
  /** Raw spec as configured (`providerId:modelId`, model id, or a chain). */
  spec: string
  /** Where the value came from: the role itself or the legacy field. */
  source: Exclude<ModelPolicyRoleSource, 'active'>
  /** The legacy field that supplied the value (only for `source: 'legacy'`). */
  legacyField?: string
}

interface SettingsShape {
  modelPolicy?: { roles?: Record<string, unknown> }
  [key: string]: unknown
}

/** Read the roles map from settings.json. Never throws. */
export function loadModelPolicyRoles(settings?: SettingsShape): Record<string, string> {
  let source = settings
  if (!source) {
    try {
      source = loadConfig<SettingsShape>('settings.json')
    } catch (err) {
      warnConfigReadFailed('settings.json', err)
      return {}
    }
  }
  const raw = source.modelPolicy?.roles
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [role, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    out[role] = trimmed
  }
  return out
}

function readPath(settings: SettingsShape, dotted: string): string {
  let cursor: unknown = settings
  for (const segment of dotted.split('.')) {
    if (!cursor || typeof cursor !== 'object') return ''
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return typeof cursor === 'string' ? cursor.trim() : ''
}

/**
 * The ONE resolution used by every background role.
 *
 *   role in modelPolicy.roles  >  legacy settings field  >  null (active provider)
 *
 * Returns `null` when neither is set; the caller then keeps using the active
 * chat provider, which is the behaviour every consumer had before the policy
 * existed.
 */
export function resolveRoleProvider(role: string, settings?: SettingsShape): RoleProviderHit | null {
  let source = settings
  if (!source) {
    try {
      source = loadConfig<SettingsShape>('settings.json')
    } catch (err) {
      warnConfigReadFailed('settings.json', err)
      return null
    }
  }
  const spec = loadModelPolicyRoles(source)[role]
  if (spec) return { role, spec, source: 'role' }

  const legacyField = MODEL_POLICY_LEGACY_FIELDS[role]
  if (legacyField) {
    const legacy = readPath(source, legacyField)
    if (legacy) return { role, spec: legacy, source: 'legacy', legacyField }
  }
  return null
}

/**
 * The one call site helper for the five background roles that still carry a
 * legacy settings field. Returns the spec a consumer should use:
 *
 *   modelPolicy.roles[role]  >  the value the caller already holds  >
 *   the legacy field on disk  >  '' (meaning: keep the active provider)
 *
 * `legacyValue` is what the consumer read from its own settings object (it
 * usually IS the legacy field, already parsed and defaulted). When the caller
 * passes it — even as an empty string — that value is authoritative and the
 * legacy field is NOT re-read from disk, so injected settings in tests and
 * dependency-injected consumers keep deciding for themselves. Only a caller
 * that passes nothing gets the on-disk legacy field as its second tier.
 */
export function resolveRoleSpec(role: string, legacyValue?: string | null): string {
  const hit = resolveRoleProvider(role)
  if (hit?.source === 'role') return gateRoleSpec(role, hit.spec).spec
  if (legacyValue !== undefined && legacyValue !== null) return gateRoleSpec(role, legacyValue.trim()).spec
  return gateRoleSpec(role, hit?.spec ?? '').spec
}

/**
 * Spec resolution and the data-policy gate for one role entry live in
 * `role-model-gate.ts` (so the task roles can use them without an import
 * cycle) and are re-exported here, where every consumer looks for them.
 */
export { gateRoleSpec, gateFallbackModel, FALLBACK_AUDIT_SUFFIX, resolveModelPolicySpec } from './role-model-gate.js'
export type { FallbackGateResult } from './role-model-gate.js'
export type { ResolvedRoleModel, RoleGateResult, SpecResolution } from './role-model-gate.js'

/** Provider types that must never be selected automatically (ADR guardrail). */
export function isBlockedProviderType(providerType: string): boolean {
  return CN_PROVIDER_TYPES.has(providerType)
}


/** `providerId:modelId` of the active provider — the read-only `default` role. */
export function resolveDefaultRole(): (ResolvedRoleModel & { composite: string }) | null {
  let file: ReturnType<typeof loadProvidersDecrypted>
  try {
    file = loadProvidersDecrypted()
  } catch {
    return null
  }
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) return null
  const modelId = file.activeModel || (provider.enabledModels ?? [])[0]
  if (!modelId) return null
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId,
    composite: `${provider.id}:${modelId}`,
  }
}
