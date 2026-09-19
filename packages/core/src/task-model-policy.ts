/**
 * task-model-policy.ts: the `task:*` roles of the model policy
 * (ADR 2026-09-13 "Modell-Policy", ADR 2026-09-17 "Task-Modellwahl").
 *
 * Background work is not one workload. A cronjob that summarizes a feed, an
 * hourly heartbeat and a multi-hour coding task have wildly different
 * requirements, and the token audit (2026-09-17) found the automatic kinds —
 * heartbeat and consolidation — carrying a grid load of ~2–4,5 Mio tokens a
 * day on the *chat* default model, with no way to pin them separately.
 *
 * Until now the only knob was `tasks.defaultProvider`, one value for every
 * background task. This module adds per-trigger-kind roles in the SAME
 * `modelPolicy.roles` block the router and the other background roles already
 * use:
 *
 *   "modelPolicy": {
 *     "roles": {
 *       "task:default":       "<providerId>:<modelId>",
 *       "task:cronjob":       "<providerId>:<modelId>",
 *       "task:heartbeat":     "<providerId>:<modelId>",
 *       "task:consolidation": "<providerId>:<modelId>",
 *       "task:user":          "<providerId>:<modelId>",
 *       "task:agent":         "<providerId>:<modelId>"
 *     }
 *   }
 *
 * This is configuration passthrough, NOT a router: one lookup, no model call,
 * no scoring. It sits at the weak end of the existing inheritance chain:
 *
 *   explicit (create_task) > parent task > persona >
 *   **modelPolicy.roles["task:<kind>"]** > tasks.defaultProvider >
 *   **modelPolicy.roles["task:default"]** > active chat provider
 *
 * The kind-specific role beats `tasks.defaultProvider` (it is the more
 * specific statement), while the generic `task:default` role stays *below*
 * it — otherwise a hand-written policy would silently override the Settings
 * UI dropdown a user just changed. With an empty policy block the resolution
 * is byte-for-byte the old one.
 */
import { loadConfig, warnConfigReadFailed } from './config.js'

/** The task kinds a role can address — identical to `tasks.trigger_type`. */
export const TASK_MODEL_ROLE_KINDS = ['user', 'agent', 'cronjob', 'heartbeat', 'consolidation'] as const

export type TaskModelRoleKind = (typeof TASK_MODEL_ROLE_KINDS)[number]

export function isTaskModelRoleKind(value: unknown): value is TaskModelRoleKind {
  return typeof value === 'string' && (TASK_MODEL_ROLE_KINDS as readonly string[]).includes(value)
}

/**
 * The role keys to try, strongest first: the specific kind, then the generic
 * `task:default`.
 */
export function taskModelRoleKeys(kind?: TaskModelRoleKind | null): string[] {
  return kind ? [`task:${kind}`, 'task:default'] : ['task:default']
}

interface TaskModelPolicyBlock {
  modelPolicy?: { roles?: Record<string, unknown> }
}

/** Read the roles map from settings.json. Never throws. */
export function loadTaskModelRoles(): Record<string, unknown> {
  try {
    const roles = loadConfig<TaskModelPolicyBlock>('settings.json').modelPolicy?.roles
    return roles && typeof roles === 'object' ? roles : {}
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return {}
  }
}

export interface TaskModelPolicyHit {
  /** The role key that matched (`task:cronjob`, `task:default`). */
  role: string
  /** The raw spec as configured: `providerId` or `providerId:modelId`. */
  spec: string
}

/**
 * First role key that carries a non-empty spec, in the given order.
 * `roles` is injectable so the resolution is unit-testable without settings.
 */
export function resolveTaskModelRoleFrom(
  keys: string[],
  roles: Record<string, unknown> = loadTaskModelRoles(),
): TaskModelPolicyHit | null {
  for (const role of keys) {
    const raw = roles[role]
    if (typeof raw !== 'string') continue
    const spec = raw.trim()
    if (!spec) continue
    return { role, spec }
  }
  return null
}

/**
 * Resolve the configured spec for a task kind (specific role first, then
 * `task:default`), or null when no role applies. Callers that need the two
 * tiers at different priorities use `resolveTaskModelRoleFrom` directly.
 */
export function resolveTaskModelRole(
  kind?: TaskModelRoleKind | null,
  roles: Record<string, unknown> = loadTaskModelRoles(),
): TaskModelPolicyHit | null {
  return resolveTaskModelRoleFrom(taskModelRoleKeys(kind), roles)
}
