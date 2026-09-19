import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
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
import { formatContinuationContext } from './task-handoff.js'
import { getSubtreeCostForTasks } from './task-cost.js'
import type { TaskCostSummary } from './task-cost.js'
import { loadHeuristics } from './heuristics.js'

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
  /**
   * Database for `context_mode` selected/fork (SPEC 11.6). Without it every
   * delegation is `clean`, which is today's behaviour.
   */
  db?: Database
  /** Token budget for the delegation context block (SPEC 10.8, default 8000). */
  contextBudgetTokens?: number
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
        // Check task exists
        const task = options.taskRuntime.getById(task_id)
        if (!task) {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" not found.` }],
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
      'Use `attached_skills` to bake the rules of specific skills into the task prompt instead of hoping the task agent discovers them.',
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
          description: 'Specific model id to use for this task (e.g. "kimi-k2.6", "gpt-5", "claude-sonnet-4-5"). Choose based on the descriptions in `<available_providers>` — prefer cost-effective models for simple work and stronger models for complex coding or research. Only pass this if you have a specific reason to deviate from the default task model. If `provider` is omitted, the provider is auto-detected from the configured providers (requires a unique match). If you omit both `provider` and `model`, the task inherits the model of the task that created it (or your active model at the top level), so sub-tasks and sub-sub-tasks stay on the same model unless you pin a different one here.',
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
      const { prompt, name, provider: providerName, model: modelName, max_duration_minutes, attached_skills, output_schema, context_mode, context, continuation_of } = params as {
        prompt: string
        name: string
        provider?: string
        model?: string
        max_duration_minutes?: number
        attached_skills?: string[]
        output_schema?: string
        continuation_of?: string
        context_mode?: string
        context?: { strand_summary?: boolean; message_ids?: number[]; memory_query?: string }
      }

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
        const taskAgentId = options.getCurrentAgentId?.() ?? undefined

        // Resolve (provider, model) into a concrete provider config.
        // - Both empty       → use default task provider (inheritance chain:
        //                       parent task's model > agent default > system default)
        // - Any combination  → run through the shared resolver so a bare
        //                       model name ("kimi-k2.6") auto-selects its
        //                       provider and an enabled-model guard runs.
        const isDefaultModel = !providerName && !modelName
        let provider: ProviderConfig
        if (providerName || modelName) {
          const resolved = resolveProviderModelInput({ provider: providerName, model: modelName })
          if (!resolved.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }],
              details: { error: true },
            }
          }
          const base = options.resolveProvider(resolved.providerId)
          if (!base) {
            return {
              content: [{ type: 'text' as const, text: `Error: Provider "${resolved.providerName}" could not be loaded.` }],
              details: { error: true },
            }
          }
          // Pin the requested model by cloning the provider config (same
          // pattern as `getTaskDefaultProvider` and the cron scheduler).
          provider = resolved.modelId === getProviderDefaultModel(base)
            ? base
            : { ...base, enabledModels: [resolved.modelId] }
        } else {
          // Fork: persona-aware default provider resolution (model inheritance
          // chain keyed by the task's agentId). Upstream 0.27.0: null-guard when
          // no default provider is configured. Keep BOTH.
          const def = options.getDefaultProvider(taskAgentId)
          if (!def) {
            return {
              content: [{ type: 'text' as const, text: 'Error: No default task provider is configured. Set one in Settings → Tasks, or pass an explicit provider/model.' }],
              details: { error: true },
            }
          }
          provider = def
        }

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
        const parentSessionId = options.getParentSessionId?.() ?? null
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
          const predecessor = options.taskRuntime.getById(predecessorId)
          if (!predecessor) {
            return {
              content: [{ type: 'text' as const, text: `Error: continuation_of task "${predecessorId}" not found.` }],
              details: { error: true },
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
          outputSchema,
          contextMode: effectiveMode,
        })

        // Start the task, linking its session to the current interactive session
        const attachedSkills = normalizeAttachedSkills(attached_skills)
        await options.taskRuntime.start(task, provider, { attachedSkills }, parentSessionId)

        const attachedSkillsLine = attachedSkills
          ? `Attached skills: ${attachedSkills.join(', ')}\n`
          : ''
        const contextLine = effectiveMode !== 'clean' || outputSchema
          ? `Context mode: ${effectiveMode}${droppedMessageIds.length ? ` (dropped message ids: ${droppedMessageIds.join(', ')})` : ''}${outputSchema ? '; output_schema enforced' : ''}\n`
          : ''
        const continuationLine = continuationOfId ? `Continuation of: ${continuationOfId}\n` : ''

        return {
          content: [{
            type: 'text' as const,
            text: `Background task started successfully.\n\nTask ID: ${task.id}\nName: ${name}\nProvider: ${provider.name}\nMax Duration: ${maxDuration} minutes\n${attachedSkillsLine}${contextLine}${continuationLine}\nThe task is now running in the background. You will receive a notification when it completes or fails.`,
          }],
          details: {
            taskId: task.id,
            name,
            provider: provider.name,
            maxDurationMinutes: maxDuration,
            attachedSkills,
            contextMode: effectiveMode,
            droppedMessageIds,
            outputSchema: Boolean(outputSchema),
            continuationOf: continuationOfId,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
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
