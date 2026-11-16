import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { TaskStatus, TaskTriggerType } from './task-store.js'
import type { ProviderConfig } from './provider-config.js'
import { resolveProviderModelInput, getProviderDefaultModel } from './provider-config.js'
import { normalizeAttachedSkills } from './attached-skills.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import type { Database } from './database.js'
import { parseOutputSchema } from './task-output-schema.js'
import { buildDelegationContext, briefTooThin } from './delegation-context.js'
import type { DelegationContextSelection } from './delegation-context.js'
import { getCurrentTaskExecutionContext } from './task-execution-context.js'
import { getManageableTask } from './task-control.js'
import type { TaskControlCaller } from './task-control.js'
import { resolveTaskControlCaller } from './task-control-tools.js'
import { checkAutomaticModelFor } from './data-policy.js'
import {
  TASK_POLICY_DIFFICULTIES,
  TASK_POLICY_KINDS,
  formatTaskRouting,
  isTaskPolicyExceptionModel,
  parseExplicitThinking,
  parseTaskProfile,
  resolveTaskPolicy,
} from './task-policy.js'
import type { StrandModelPinRef } from './task-policy.js'
import { formatContinuationContext } from './task-handoff.js'
import { readPersonaDirectoryEntry, resolveDelegationTarget } from './persona-directory.js'
import { failPersonaDelegation, recordPersonaDelegation } from './persona-delegation-log.js'
import { getSubtreeCostForTasks } from './task-cost.js'
import type { TaskCostSummary } from './task-cost.js'
import { loadHeuristics } from './heuristics.js'
import { isPrivateMcpSession, skipPrivateMcpSession } from './mcp-egress.js'
import { checkLeanPreconditions, parseWorkerProfileInput } from './lean-worker-profile.js'

export interface TaskToolsOptions {
  taskRuntime: TaskRuntimeTaskBoundary
  /**
   * Get the default provider to use for tasks. Receives the agentId the new
   * task is attributed to (if any), so implementations can apply the model
   * inheritance chain: parent task's model > agent/persona default > system
   * default (see `resolveTaskDefaultProvider` in task-provider-resolution.ts).
   * Zero-arg implementations remain valid and simply ignore the agent.
   * Returns null when no provider is configured (upstream 0.27.0 null-guard);
   * callers must handle the null and surface a clear error.
   */
  getDefaultProvider: (agentId?: string | null) => ProviderConfig | null
  /** Resolve a provider by name/id */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Default max duration from settings */
  defaultMaxDurationMinutes: number
  /** Hard cap on max duration from settings */
  maxDurationMinutesCap: number
  /**
   * Returns the current interactive session ID that triggered the tool call,
   * so that the new task's session can be linked via `parent_session_id`.
   * Returns null when no interactive session is active (e.g. tool invoked
   * from a background context).
   */
  getParentSessionId?: () => string | null
  /**
   * Returns the agentId of the persona runtime currently executing the tool
   * call, so the new task is attributed to it and its result routes back to
   * the same persona. Undefined when invoked from a background context.
   */
  getCurrentAgentId?: () => string | undefined
  /** User of the interactive caller; background tasks use their ALS origin. */
  getCurrentUserId?: () => number | undefined
  /**
   * Persona folders root (`<DATA_DIR>/agents`) for the `persona` parameter;
   * tests point it at a temp dir. Defaults to `$DATA_DIR/agents`.
   */
  personaBaseDir?: string
  /**
   * Resolve a provider/model input (explicit `model`/`provider`, and the
   * `Model:` line of a delegated persona). Defaults to
   * `resolveProviderModelInput` over the configured providers; tests inject.
   */
  resolveModelInput?: typeof resolveProviderModelInput
  /**
   * Database for `context_mode` selected/fork (SPEC 11.6). Without it every
   * delegation is `clean`, which is today's behaviour.
   */
  db?: Database
  /** Token budget for the delegation context block (SPEC 10.8, default 8000). */
  contextBudgetTokens?: number
  /**
   * Model pin of the strand whose turn calls `create_task` (task policy, plan
   * 2026-10-01). Receives the session id of THIS turn (`getParentSessionId`),
   * never a globally "active" strand, so two strands delegating at the same
   * time each see their own pin. Defaults to reading `sessions` via `db`.
   */
  getStrandModelPin?: (sessionId: string) => StrandModelPinRef | null
  /**
   * Data-policy gate for a model the task policy picks automatically.
   * Defaults to `checkAutomaticModelFor` (role `task:policy`).
   */
  checkAutomaticModel?: (provider: ProviderConfig, modelId: string) => { allowed: boolean; reason: string }
}

function readStrandModelPin(db: Database | undefined, sessionId: string): StrandModelPinRef | null {
  if (!db) return null
  try {
    const row = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?')
      .get(sessionId) as { model_provider_id: string | null; model_id: string | null } | undefined
    return row?.model_provider_id && row.model_id
      ? { providerId: row.model_provider_id, modelId: row.model_id }
      : null
  } catch {
    return null
  }
}

function defaultCheckAutomaticModel(provider: ProviderConfig, modelId: string): { allowed: boolean; reason: string } {
  try {
    const decision = checkAutomaticModelFor(provider, modelId, 'task:policy')
    return { allowed: decision.allowed, reason: decision.reason }
  } catch (err) {
    // Fail closed: an automatic choice the gate cannot judge is not used.
    return { allowed: false, reason: `gate_error: ${(err as Error)?.message ?? 'unknown'}` }
  }
}

/**
 * Create the `resume_task` agent tool
 */
export function createResumeTaskTool(options: TaskToolsOptions): AgentTool {
  return {
    name: 'resume_task',
    label: 'Resume Paused Task',
    description:
      'Send a response to a paused background task. Use this when a task has asked a question ' +
      '(status: question) and the user has now answered. Include the answer plus any brief context the task needs, then the task resumes in the background.',
    parameters: Type.Object({
      task_id: Type.String({
        description: 'The ID of the paused task to resume.',
      }),
      message: Type.String({
        description: 'The response message to send to the paused task. Include the user\'s answer and any relevant context.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { task_id, message } = params as { task_id: string; message: string }

      try {
        // The same owner/persona/descendant guard as steer_task and cancel_task.
        // Fail closed without a DB, and do not disclose whether a foreign id exists.
        const caller: TaskControlCaller = resolveTaskControlCaller(options)
        const task = options.db
          ? getManageableTask(options.db, options.taskRuntime, caller, task_id)
          : null
        if (!task) {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" not found or not manageable from here.` }],
            details: { error: true },
          }
        }

        if (task.status !== 'paused') {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" is not paused (current status: ${task.status}).` }],
            details: { error: true },
          }
        }

        // Check if the task agent is still in memory
        if (!options.taskRuntime.isPaused(task_id)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" agent is no longer in memory. The task may have timed out.` }],
            details: { error: true },
          }
        }

        // Resume the task
        const resumed = await options.taskRuntime.resume(task_id, message)
        if (!resumed) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to resume task "${task_id}".` }],
            details: { error: true },
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Task "${task.name}" (${task_id}) has been resumed with your response. It will continue working in the background.`,
          }],
          details: {
            taskId: task_id,
            name: task.name,
            status: 'running',
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error resuming task: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `create_task` agent tool
 */
export function createTaskTool(options: TaskToolsOptions): AgentTool {
  return {
    name: 'create_task',
    label: 'Create Background Task',
    description:
      'Start a background task that runs autonomously. Use this for complex, long-running, or parallelizable work ' +
      'that should continue in the background (e.g., building apps, substantial refactors, multi-step research, complex file operations). ' +
      'Do not use it for simple questions or quick checks you can finish in the current turn. ' +
      'Provide a self-contained prompt; the task runs in an isolated agent instance and reports back when complete, fails, or needs input. ' +
      'Use `attached_skills` to bake the rules of specific skills into the task prompt instead of hoping the task agent discovers them. ' +
      'Classify the work with `task_kind` and `difficulty`: the model tier and thinking level are then chosen deterministically ' +
      'inside the provider the task runs on (an explicit provider/model pin always wins; otherwise the parent task\'s, then this strand\'s provider).',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Detailed, self-contained prompt describing what the task should accomplish. Include the goal, constraints, relevant files or URLs, required checks, and the expected final deliverable. Write it so the task can proceed without relying on hidden chat context.',
      }),
      name: Type.String({
        description: 'Short, descriptive name for the task (e.g., "Build React App", "Research AI Papers")',
      }),
      provider: Type.Optional(
        Type.String({
          description: 'Provider name or id to use for this task (e.g. "Kimi.ai", "OpenAI"). Choose the most appropriate provider based on the descriptions in `<available_providers>`. You may autonomously select a model that matches the task\'s needs. Only pass this if you have a specific reason to deviate from the default task model. Can be combined with `model` to pin both.',
        })
      ),
      model: Type.Optional(
        Type.String({
          description: 'Specific model id to use for this task (e.g. "kimi-k2.6", "gpt-5", "claude-sonnet-4-5"). Choose based on the descriptions in `<available_providers>` — prefer cost-effective models for simple work and stronger models for complex coding or research. Every enabled model is accepted, also the ones listed there without a description; a user-facing name such as "Opus 4.6" is mapped to its id, and an unknown model returns the list of enabled ids. Only pass this if you have a specific reason to deviate from the default task model. If `provider` is omitted, the provider is auto-detected from the configured providers (requires a unique match). If you omit both `provider` and `model`, a sub-task stays on the provider of the task that created it; at the top level the provider of this strand is used (falling back to the configured task default). Inside that provider `task_kind`/`difficulty` pick the model tier (without them: general/medium in the provider of this strand, or the inherited/default model).',
        })
      ),
      task_kind: Type.Optional(
        Type.String({
          description: `What kind of work this is: ${TASK_POLICY_KINDS.join(' | ')}. extraction = bounded, checkable pulling/sorting of data; research = finding and weighing sources; review = critique of a diff/text/plan; coding = changing code; ops = system work with side effects; general = anything else. Picks the model tier and thinking level together with \`difficulty\`.`,
        })
      ),
      difficulty: Type.Optional(
        Type.String({
          description: `Difficulty AND risk of the task: ${TASK_POLICY_DIFFICULTIES.join(' | ')}. Use high for multi-step, multi-file, irreversible or security-relevant work; low for short, bounded, easily checked work. If only one of task_kind/difficulty is given, the other defaults to general/medium. With neither, a top-level call in a pinned strand uses general/medium (thrifty but capable); sub-tasks and calls without strand keep the inherited/default model and the background thinking level.`,
        })
      ),
      thinking: Type.Optional(
        Type.String({
          description: 'Optional explicit thinking level (off | minimal | low | medium | high | xhigh). Normally leave it out — task_kind/difficulty choose it. "xhigh" is never automatic and requires model_reason.',
        })
      ),
      persona: Type.Optional(
        Type.String({
          description: 'Optional persona id the task runs AS (its memory, persona files and model default), e.g. "bob". Only the default persona may name another persona; every other persona may only name itself. The result still comes back to YOU, in this strand. Omit to run the task as yourself.',
        })
      ),
      model_reason: Type.Optional(
        Type.String({
          description: 'Short justification, REQUIRED for an exception model (the astra/fable lines) — pinned directly, as the default of an explicit provider, or as the configured default task model — and for thinking "xhigh". Shown in the task routing record.',
        })
      ),
      max_duration_minutes: Type.Optional(
        Type.Number({
          description: 'Maximum duration in minutes for this task. Cannot exceed the system maximum. Defaults to system default if not specified.',
        })
      ),
      attached_skills: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional list of agent-skill names (directory names under /data/skills_agent/<name>/) or installed skill ids ("owner/name") whose SKILL.md should be injected directly into the task prompt. Use this to bake skill rules into the prompt deterministically instead of requiring the task agent to read_file them. Example: ["nitter", "reddit"]. Missing SKILL.md files are skipped with a warning, the task still runs.',
        })
      ),
      output_schema: Type.Optional(
        Type.String({
          description: 'Optional JSON Schema (as a JSON string, type "object") that the task\'s SUMMARY must satisfy. Use it when you will process the result programmatically or need a fixed shape (e.g. {"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"string"}}}}). The runner validates the result and allows the task exactly one correction round; a result that still fails the schema fails the task.',
        })
      ),
      worker_profile: Type.Optional(
        Type.String({
          description: 'Optional "lean_local": run as a lean LOCAL worker (local Ollama model only) that reads private raw data itself and returns only the schema-validated result. Short fixed system prompt, no memory/skills/persona files, tools read_file/list_files/shell/email_list/email_read only, no reviewer round. Requires output_schema and a local provider; refuses to start otherwise (no cloud fallback). Put everything the worker needs (paths, ids) into prompt.',
        })
      ),
      context_mode: Type.Optional(
        Type.String({
          description: 'What the task receives besides the prompt: "clean" (default, prompt only; use for reviews and critique), "selected" (prompt plus the items named in `context`), or "fork" (prompt plus the verbatim recent window of this conversation, for decisions that depend on the history).',
        })
      ),
      continuation_of: Type.Optional(
        Type.String({
          description: 'Optional id of a predecessor task this task continues (e.g. one that hit its time budget or failed with work left). Its handoff/summary is injected into the new task\'s prompt as a clearly marked `<continuation_of>` block, so the successor picks up where the predecessor stopped instead of starting from zero.',
        })
      ),
      context: Type.Optional(
        Type.Object({
          strand_summary: Type.Optional(Type.Boolean({ description: 'Pass the structured summary of this conversation.' })),
          message_ids: Type.Optional(Type.Array(Type.Number(), { description: 'Up to 10 message ids from this conversation to pass verbatim.' })),
          memory_query: Type.Optional(Type.String({ description: 'Memory search whose top 10 facts are passed.' })),
        }, { description: 'Explicit context selection for context_mode "selected".' })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { prompt, name, provider: providerName, model: modelName, max_duration_minutes, attached_skills, output_schema, context_mode, context, continuation_of, task_kind, difficulty, thinking, model_reason, persona, worker_profile } = params as {
        prompt: string
        worker_profile?: string
        persona?: string
        name: string
        provider?: string
        model?: string
        task_kind?: string
        difficulty?: string
        thinking?: string
        model_reason?: string
        max_duration_minutes?: number
        attached_skills?: string[]
        output_schema?: string
        continuation_of?: string
        context_mode?: string
        context?: { strand_summary?: boolean; message_ids?: number[]; memory_query?: string }
      }

      // Id of the persona_delegations row, closed as failed if the start throws.
      let delegationLogId: number | null = null
      try {
        // Output contract (SPEC 11.6): validated here so a broken schema is
        // the caller's error, not a failed task an hour later.
        let outputSchema: string | null = null
        if (output_schema !== undefined && output_schema !== null && String(output_schema).trim() !== '') {
          const parsedSchema = parseOutputSchema(output_schema)
          if (!parsedSchema.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${parsedSchema.error}` }],
              details: { error: true },
            }
          }
          outputSchema = parsedSchema.serialized
        }

        // Context mode (SPEC 11.6). `clean` is the default and today's behaviour.
        const requestedMode = (context_mode ?? 'clean').trim().toLowerCase()
        if (!['clean', 'selected', 'fork'].includes(requestedMode)) {
          return {
            content: [{ type: 'text' as const, text: `Error: context_mode must be "clean", "selected" or "fork" (got "${context_mode}").` }],
            details: { error: true },
          }
        }
        const contextMode = requestedMode as 'clean' | 'selected' | 'fork'
        const selection: DelegationContextSelection | undefined = context
          ? { strandSummary: context.strand_summary, messageIds: context.message_ids, memoryQuery: context.memory_query }
          : undefined
        if (briefTooThin(prompt, contextMode, selection)) {
          return {
            content: [{ type: 'text' as const, text: `Error: brief too thin for a reader without history. Write a self contained prompt of at least ${loadHeuristics().delegation.minBriefChars} characters, or pass context_mode "selected" with a context selection, or "fork".` }],
            details: { error: true },
          }
        }
        // Attribution target of the new task. Resolved ONCE so the same value
        // is used for (a) the persona-default lookup in the model inheritance
        // chain and (b) the agentId stored on the task row — deterministic
        // data pass-through, never re-inferred later.
        //
        // `persona` (plan persona-architektur 1c): the default persona may run
        // the task AS another persona. The task then carries that persona's
        // id (memory root, persona files, persona model default in the chain
        // below) and records the caller in `delegatedBy`, which every delivery
        // path uses to route the outcome back to the caller's strand.
        const callerAgentId = options.getCurrentAgentId?.() ?? undefined
        const target = resolveDelegationTarget({
          requested: persona,
          callerAgentId,
          baseDir: options.personaBaseDir,
          db: options.db,
        })
        if (!target.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${target.error}` }], details: { error: true } }
        }
        const delegatedBy = target.foreign ? (callerAgentId ?? 'main') : null
        const taskAgentId = target.foreign ? target.personaId : callerAgentId

        // Task policy (plan 2026-10-01): resolve provider, model and thinking
        // level deterministically from the structured profile — no second
        // LLM call, no prompt parsing.
        //   explicit model > explicit provider (+ tier) > parent task (ALS)
        //   > pin of THIS turn's strand (tie-breaker) > default chain
        //     (persona > task:agent role > tasks.defaultProvider > active)
        // An automatically chosen model must be enabled and pass the data
        // policy gate; otherwise the call fails with a clear error.
        const profile = parseTaskProfile({ task_kind, difficulty })
        if (!profile.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${profile.error}` }], details: { error: true } }
        }
        const explicitThinking = parseExplicitThinking(thinking)
        if (!explicitThinking.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${explicitThinking.error}` }], details: { error: true } }
        }
        const noExplicitPin = !providerName && !modelName
        const resolveModelInput = options.resolveModelInput ?? resolveProviderModelInput
        // Delegated persona model (1c): the `Model:` line of the target
        // persona's IDENTITY.md is the default of a delegated task, but only
        // when the caller set neither `model` nor `provider`, and only if it
        // resolves to exactly one enabled model. Otherwise the regular chain
        // below applies unchanged (parent task > strand pin > persona
        // provider setting > task defaults).
        let personaModel: string | undefined
        if (target.foreign && noExplicitPin) {
          const spec = readPersonaDirectoryEntry(target.personaId, options.personaBaseDir).model?.trim()
          const resolved = spec ? resolveModelInput({ model: spec }) : null
          // An exception model needs an explicit model_reason; a persona file
          // is not one, so such a persona default falls back to the chain.
          if (spec && resolved?.ok && (!isTaskPolicyExceptionModel(resolved.modelId) || model_reason?.trim())) {
            personaModel = spec
          }
        }
        // Bound to the session of THIS turn (AsyncLocalStorage in AgentCore),
        // not to whatever strand is active elsewhere; null inside tasks.
        const turnSessionId = options.getParentSessionId?.() ?? null
        // MCP local_only (fail closed): the brief of a task started from a
        // private strand may quote private MCP output, and the task model is
        // not known to be strictly local. Starting tasks is disabled there.
        // Review 3 / P2: no strand id is never "clean". Inside a task the
        // task's own session and its origin strand are checked; with no id at
        // all the shared classification treats the scope as unknown (refused).
        const taskCtx = getCurrentTaskExecutionContext()
        const scopeIds = turnSessionId
          ? [turnSessionId]
          : [taskCtx?.taskSessionId, taskCtx?.sessionId].filter((id): id is string => typeof id === 'string' && id.length > 0)
        if ((scopeIds.length === 0 ? [null] : scopeIds).some(id => skipPrivateMcpSession(options.db, id, 'create_task'))) {
          return { content: [{ type: 'text' as const, text: 'Error: MCP privacy gate: this strand holds private (local_only) MCP data, so create_task is disabled here. Start the task from a new strand without that data.' }], details: { error: true, mcpPrivate: true } }
        }
        const parentProvider = getCurrentTaskExecutionContext()?.provider ?? null
        const strandPin = !parentProvider && turnSessionId
          ? (options.getStrandModelPin ?? ((id: string) => readStrandModelPin(options.db, id)))(turnSessionId)
          : null
        const policy = resolveTaskPolicy({
          explicitProvider: providerName?.trim() || undefined,
          explicitModel: modelName?.trim() || personaModel,
          explicitThinking: explicitThinking.value,
          modelReason: model_reason,
          profile: profile.value,
          parentProvider,
          strandPin,
          resolveProvider: options.resolveProvider,
          resolveExplicit: (input) => resolveModelInput(input),
          getDefaultProvider: () => options.getDefaultProvider(taskAgentId),
          checkAutomatic: options.checkAutomaticModel ?? defaultCheckAutomaticModel,
        })
        if (!policy.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${policy.error}` }], details: { error: true } }
        }
        const provider: ProviderConfig = policy.provider
        // Lean local worker (plan 2026-10-18-lokale-worker, B2): validated
        // here so a wrong pin is the caller's error at once — never a task
        // that silently runs on the cloud default instead.
        const parsedProfile = parseWorkerProfileInput(worker_profile)
        if (!parsedProfile.ok) {
          return { content: [{ type: 'text' as const, text: parsedProfile.error }], details: { error: true } }
        }
        const workerProfile = parsedProfile.profile
        if (workerProfile) {
          const refusal = checkLeanPreconditions({ provider, outputSchema })
          if (refusal) return { content: [{ type: 'text' as const, text: `Error: ${refusal}. Pin a local provider/model (e.g. provider "Ollama") and pass output_schema.` }], details: { error: true } }
        }
        // "Default model" = nobody chose it: no explicit pin, no profile and no
        // strand tie-breaker pick — i.e. exactly the inherited/default chain.
        const isDefaultModel = noExplicitPin
          && (policy.routing.source === 'default' || policy.routing.source === 'parent')
          && policy.routing.kind === null

        // Cap max duration
        let maxDuration = max_duration_minutes ?? options.defaultMaxDurationMinutes
        if (maxDuration > options.maxDurationMinutesCap) {
          maxDuration = options.maxDurationMinutesCap
        }
        if (maxDuration <= 0) {
          maxDuration = options.defaultMaxDurationMinutes
        }

        // Delegation context (SPEC 10.8 / 11.6): resolved once and prepended
        // to the prompt so the task row shows exactly what was passed in.
        const parentSessionId = turnSessionId
        let effectivePrompt = prompt
        let droppedMessageIds: number[] = []
        let effectiveMode: 'clean' | 'selected' | 'fork' = contextMode
        if (contextMode !== 'clean' && options.db) {
          const built = buildDelegationContext({
            db: options.db,
            mode: contextMode,
            parentSessionId,
            agentId: taskAgentId,
            selection,
            budgetTokens: options.contextBudgetTokens,
          })
          effectiveMode = built.mode
          droppedMessageIds = built.droppedMessageIds
          if (built.block) effectivePrompt = `${built.block}\n\n${prompt}`
        } else if (contextMode !== 'clean') {
          effectiveMode = 'clean'
        }

        // W5/P2: continuation chain. The predecessor's own final state is
        // prepended as a marked block (never merged into the brief), so the
        // successor can verify it instead of inheriting it as truth. An
        // unknown id is the caller's error and fails fast — silently dropping
        // it would start a task that believes it has context it never got.
        let continuationOfId: string | null = null
        if (continuation_of !== undefined && String(continuation_of).trim() !== '') {
          const predecessorId = String(continuation_of).trim()
          // A continuation contains the predecessor's prompt and result. Apply
          // the same user/persona/descendant boundary as get_task, including
          // identical errors for unknown and inaccessible ids.
          // Same caller rule as get_task, incl. the stale-context fallback (S0-A / A4).
          const caller: TaskControlCaller = resolveTaskControlCaller(options)
          const predecessor = options.db
            ? getManageableTask(options.db, options.taskRuntime, caller, predecessorId)
            : null
          if (!predecessor) {
            return {
              content: [{ type: 'text' as const, text: `Error: continuation_of task "${predecessorId}" not found or not manageable from here.` }],
              details: { error: true },
            }
          }
          // Review 5: a predecessor whose session (or its parent strand) holds
          // private MCP material is never copied into a new task. Fail closed.
          let predecessorPrivate = true
          try {
            const sid = (predecessor as { sessionId?: string | null }).sessionId ?? null
            const parent = sid && options.db
              ? (options.db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?').get(sid) as { parent_session_id: string | null } | undefined)?.parent_session_id ?? null
              : null
            predecessorPrivate = (sid !== null && isPrivateMcpSession(options.db, sid)) || (parent !== null && isPrivateMcpSession(options.db, parent))
          } catch { predecessorPrivate = true }
          if (predecessorPrivate) {
            return {
              content: [{ type: 'text' as const, text: `Error: MCP privacy gate: continuation_of task "${predecessorId}" belongs to a strand with private (local_only) MCP data and is not handed to a new task.` }],
              details: { error: true, mcpPrivate: true },
            }
          }
          continuationOfId = predecessor.id
          effectivePrompt = `${formatContinuationContext(predecessor)}\n\n${effectivePrompt}`
        }

        // Who delegated this task. Read from the task execution context (ALS),
        // which the task runner binds around every agent run — so a sub-task
        // created from inside task A carries A's id, deterministically, even
        // while task B runs concurrently. Undefined at the top level
        // (interactive turn), where the strand itself is the parent and the
        // session lineage already says so.
        //
        // This edge is what makes a sub-task visible in the strand's task
        // tree: background task tools pass `null` as parent session, so the
        // session lineage breaks after the first generation.
        const parentTaskId = getCurrentTaskExecutionContext()?.taskId

        // Create the task in the store — sessionId is created by the
        // TaskRunner via SessionManager when the task starts.
        const task = options.taskRuntime.create({
          name,
          prompt: effectivePrompt,
          triggerType: 'agent',
          ...(parentTaskId ? { triggerSourceId: parentTaskId } : {}),
          provider: provider.name,
          model: getProviderDefaultModel(provider),
          isDefaultModel,
          maxDurationMinutes: maxDuration,
          agentId: taskAgentId,
          delegatedBy,
          outputSchema,
          contextMode: effectiveMode,
          thinkingLevel: policy.thinking,
          routing: policy.routing,
          workerProfile,
        })

        if (delegatedBy && taskAgentId) {
          delegationLogId = recordPersonaDelegation(options.db, {
            callerAgentId: delegatedBy,
            targetAgentId: taskAgentId,
            kind: 'task',
            taskId: task.id,
            sessionId: parentSessionId,
          })
        }

        // Start the task, linking its session to the current interactive session
        const attachedSkills = normalizeAttachedSkills(attached_skills)
        await options.taskRuntime.start(task, provider, { attachedSkills }, parentSessionId)

        const attachedSkillsLine = attachedSkills
          ? `Attached skills: ${attachedSkills.join(', ')}\n`
          : ''
        const contextLine = effectiveMode !== 'clean' || outputSchema
          ? `Context mode: ${effectiveMode}${droppedMessageIds.length ? ` (dropped message ids: ${droppedMessageIds.join(', ')})` : ''}${outputSchema ? '; output_schema enforced' : ''}${workerProfile ? `; worker_profile ${workerProfile}` : ''}\n`
          : ''
        const continuationLine = continuationOfId ? `Continuation of: ${continuationOfId}\n` : ''
        const personaLine = delegatedBy
          ? `Persona: ${taskAgentId} (delegated by ${delegatedBy}; the result comes back to you)${personaModel ? `; model from persona: ${personaModel}` : ''}\n`
          : ''
        const routingLine = `Model: ${formatTaskRouting(policy.routing)}\n`

        // The per-provider limit (`tasks.maxConcurrentPerProvider`) or the
        // global cap (`tasks.maxConcurrent`) can put the task in a FIFO queue
        // instead of starting it right away. Say so plainly: the caller must
        // not poll or wait for a task that has not started yet.
        const queueInfo = options.taskRuntime.queueInfo?.(task.id)
        const queued = queueInfo?.queued === true
        const headline = queued
          ? `Background task created and queued (position ${queueInfo.position}, ${queueInfo.running} running).`
          : 'Background task started successfully.'
        const limitText = !queued
          ? ''
          : queueInfo.reason === 'provider'
            ? `provider limit: ${queueInfo.provider_limit} concurrent task(s) on this provider, ${queueInfo.provider_running} running`
            : `global limit: ${queueInfo.limit} concurrent task(s) across all providers`
        const closing = queued
          ? `The task waits for a free slot and starts automatically when one frees up (${limitText}). `
            + 'Do NOT poll or wait for it — continue with your own work; you will receive a notification when it completes or fails.'
          : 'The task is now running in the background. You will receive a notification when it completes or fails.'

        return {
          content: [{
            type: 'text' as const,
            text: `${headline}\n\nTask ID: ${task.id}\nName: ${name}\nProvider: ${provider.name}\n${routingLine}Max Duration: ${maxDuration} minutes\n${attachedSkillsLine}${contextLine}${continuationLine}${personaLine}\n${closing}`,
          }],
          details: {
            taskId: task.id,
            name,
            provider: provider.name,
            model: policy.modelId,
            thinkingLevel: policy.thinking,
            routing: policy.routing,
            maxDurationMinutes: maxDuration,
            attachedSkills,
            contextMode: effectiveMode,
            droppedMessageIds,
            outputSchema: Boolean(outputSchema),
            continuationOf: continuationOfId,
            ...(delegatedBy ? { persona: taskAgentId, delegatedBy } : {}),
            queued,
            ...(queued
              ? {
                  queuePosition: queueInfo.position,
                  runningTasks: queueInfo.running,
                  maxConcurrentTasks: queueInfo.limit,
                  ...(queueInfo.reason
                    ? {
                        queueReason: queueInfo.reason,
                        providerRunningTasks: queueInfo.provider_running,
                        maxConcurrentTasksPerProvider: queueInfo.provider_limit,
                      }
                    : {}),
                }
              : {}),
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        // A delegation whose task never started must not stay open forever.
        failPersonaDelegation(options.db, delegationLogId, `start failed: ${errorMsg}`)
        return {
          content: [{ type: 'text' as const, text: `Error creating task: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `list_tasks` agent tool
 */
export function listTasksTool(options: Pick<TaskToolsOptions, 'taskRuntime' | 'db'>): AgentTool {
  return {
    name: 'list_tasks',
    label: 'List Background Tasks',
    description:
      'List background tasks with optional filters. Use this to check the status of running tasks, ' +
      'find completed or failed tasks, or get an overview of all tasks. Returns the most recent tasks first.',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: 'Filter by status: "running", "paused", "completed", or "failed". Omit to show all.',
        })
      ),
      trigger_type: Type.Optional(
        Type.String({
          description: 'Filter by trigger type: "user", "agent", "cronjob", or "heartbeat". Omit to show all.',
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of tasks to return (default: 20, max: 50).',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { status, trigger_type, limit } = params as {
        status?: string
        trigger_type?: string
        limit?: number
      }

      try {
        const tasks = options.taskRuntime.list({
          status: status as TaskStatus | undefined,
          triggerType: trigger_type as TaskTriggerType | undefined,
          limit: Math.min(limit ?? 20, 50),
        })

        if (tasks.length === 0) {
          const filterDesc = [status, trigger_type].filter(Boolean).join(', ')
          return {
            content: [{ type: 'text' as const, text: filterDesc
              ? `No tasks found matching filters: ${filterDesc}.`
              : 'No tasks found.'
            }],
            details: { count: 0 },
          }
        }

        // P7a: a task that delegated work looks cheap on its own row — the
        // bill sits on its sub-tasks. Aggregate the delegation subtree via
        // `tasks.trigger_source_id` (one query per parent, only for tasks
        // that actually have children). Without a db handle the tool behaves
        // exactly as before.
        let subtrees = new Map<string, TaskCostSummary>()
        if (options.db) {
          try {
            subtrees = getSubtreeCostForTasks(options.db, tasks.map(t => t.id))
          } catch {
            // Accounting is a nice-to-have; never fail the listing over it.
          }
        }

        const lines = tasks.map(t => {
          const duration = t.startedAt
            ? (() => {
                const start = new Date(t.startedAt.replace(' ', 'T') + 'Z').getTime()
                const end = t.completedAt
                  ? new Date(t.completedAt.replace(' ', 'T') + 'Z').getTime()
                  : Date.now()
                const mins = Math.round((end - start) / 60000)
                return mins < 1 ? '<1m' : `${mins}m`
              })()
            : '\u2014'
          const tokens = t.promptTokens + t.completionTokens
          const subtree = subtrees.get(t.id)
          const chain = subtree && subtree.descendants > 0
            ? `\n  Incl. ${subtree.descendants} sub-task(s): Tokens: ${subtree.subtree.promptTokens + subtree.subtree.completionTokens} | Cost: $${subtree.subtree.estimatedCost.toFixed(4)}`
            : ''
          return `\u2022 [${t.status.toUpperCase()}] ${t.name}\n  ID: ${t.id}\n  Trigger: ${t.triggerType} | Duration: ${duration} | Tokens: ${tokens} | Cost: $${t.estimatedCost.toFixed(4)}${chain}\n  Created: ${t.createdAt}`
        })

        return {
          content: [{ type: 'text' as const, text: `Found ${tasks.length} task(s):\n\n${lines.join('\n\n')}` }],
          details: {
            count: tasks.length,
            // Machine-readable chain costs for the tasks that spawned
            // sub-tasks (same numbers as the rendered line).
            subtreeCosts: [...subtrees.values()]
              .filter(s => s.descendants > 0)
              .map(s => ({
                taskId: s.taskId,
                descendants: s.descendants,
                promptTokens: s.subtree.promptTokens,
                completionTokens: s.subtree.completionTokens,
                cacheRead: s.subtree.cacheRead,
                cacheWrite: s.subtree.cacheWrite,
                estimatedCost: s.subtree.estimatedCost,
                toolCalls: s.subtree.toolCalls,
                cacheReadRatio: s.subtree.cacheReadRatio,
                truncated: s.truncated,
              })),
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error listing tasks: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}
