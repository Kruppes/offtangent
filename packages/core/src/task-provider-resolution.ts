import type { ProviderConfig } from './provider-config.js'
import { parseProviderModelId } from './provider-config.js'
import { getCurrentTaskProvider, getCurrentTaskAgentId } from './task-execution-context.js'

/**
 * Options for resolving the DEFAULT provider/model of a task that was created
 * without an explicit provider/model.
 *
 * The full inheritance chain (strong to weak) is:
 *
 *   1. explicit provider/model on `create_task`   — handled by the tool itself
 *                                                    BEFORE this resolver runs
 *   2. the parent task's provider (model-pinned)  — via AsyncLocalStorage task
 *                                                    execution context
 *   3. the agent/persona default                  — `multiPersona.perAgentProvider[agentId]`
 *                                                    (format `providerId[:modelId]`)
 *   4. the system default                         — `tasks.defaultProvider`,
 *                                                    else the active chat provider
 *
 * This function implements steps 2–4. It is deliberately dependency-injected
 * (spec lookup, provider resolution, system default) so the chain is unit
 * testable in core without the web-backend composition layer.
 */
export interface TaskDefaultProviderChainOptions {
  /**
   * The agent/persona the new task is attributed to. When omitted, the
   * agentId of the currently executing task (ALS context) is used — so a
   * sub-task spawned from inside a persona's task inherits that persona.
   */
  agentId?: string | null
  /**
   * Look up the per-agent default provider spec (`providerId[:modelId]`).
   * Absent / returning null-ish means: no persona default, fall through.
   */
  getPerAgentProviderSpec?: (agentId: string) => string | null | undefined
  /** Resolve a provider config by id or name. */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** The system default (tasks.defaultProvider → active provider). */
  getSystemDefault: () => ProviderConfig
}

/**
 * Resolve the default provider for a new task according to the inheritance
 * chain: parent task's model > agent/persona default > system default.
 *
 * NOTE on priority: the parent's provider wins even when the parent itself
 * only inherited the system default. This is the documented, deterministic
 * ordering (explicit > parent > agent > system) — no special-casing of "the
 * parent happened to run on the default".
 */
export function resolveTaskDefaultProvider(options: TaskDefaultProviderChainOptions): ProviderConfig {
  // 2. Parent task inheritance (only set while executing inside a task).
  const parentProvider = getCurrentTaskProvider()
  if (parentProvider) return parentProvider

  // 3. Agent/persona default.
  const agentId = options.agentId ?? getCurrentTaskAgentId() ?? undefined
  if (agentId && options.getPerAgentProviderSpec) {
    const spec = options.getPerAgentProviderSpec(agentId)
    if (spec) {
      const { providerId, modelId } = parseProviderModelId(spec)
      const base = providerId ? options.resolveProvider(providerId) : null
      if (base) {
        // Pin the requested model by narrowing enabledModels — the same
        // cloning pattern used by getTaskDefaultProvider and create_task.
        return modelId ? { ...base, enabledModels: [modelId] } : base
      }
      // Unresolvable spec: fall through to the system default rather than
      // failing task creation (conservative, matches getTaskDefaultProvider).
    }
  }

  // 4. System default.
  return options.getSystemDefault()
}
