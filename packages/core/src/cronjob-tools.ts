import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ScheduledTaskActionType } from './scheduled-task-store.js'
import type { TaskRuntimeScheduleBoundary } from './task-runtime.js'
import { validateCronExpression, cronToHumanReadable, parseCronExpression, getNextRunTime } from './cron-parser.js'
import { resolveProviderModelInput } from './provider-config.js'
import { normalizeAttachedSkills } from './attached-skills.js'

/**
 * Resolve the (provider, model) pair a user may pass to a cronjob tool into
 * the composite `providerId:modelId` string we persist in `scheduled_tasks.provider`.
 *
 * Returns `undefined` when neither field is set (caller should store `undefined`,
 * which means "use the task default provider at fire time").
 * Returns an error string when the input is set but cannot be resolved.
 */
function resolveCronjobProviderValue(provider?: string, model?: string):
  | { ok: true; value: string | undefined; label: string | null }
  | { ok: false; error: string } {
  if (!provider && !model) {
    return { ok: true, value: undefined, label: null }
  }
  const resolved = resolveProviderModelInput({ provider, model })
  if (!resolved.ok) return resolved
  return {
    ok: true,
    value: resolved.composite,
    label: `${resolved.providerName} (${resolved.modelId})`,
  }
}

export interface CronjobToolsOptions {
  taskRuntime: TaskRuntimeScheduleBoundary
  /** Returns the agentId of the persona runtime currently executing the tool call */
  getCurrentAgentId?: () => string | undefined
}

function looksLikeDynamicTaskRequest(name: string, message: string): boolean {
  const text = `${name}\n${message}`.toLowerCase()

  const dynamicPatterns = [
    /\b(current|latest|aktuell(?:e|en|er)?|neueste[nsmr]?)\b/u,
    /\b(weather|wetter|forecast|temperature|temperatur)\b/u,
    /\b(check|prüf(?:e|en)?|verify|look up|lookup|fetch|get|hole|ermittle)\b/u,
    /\b(search|research|analy[sz]e|analysiere|summari[sz]e|fasse .* zusammen)\b/u,
    /\b(use skill|verwende skill|nutze skill|mit skill)\b/u,
    /\b(report|berichte|teile .* mit|send me the result|schick .* ergebnis)\b/u,
    /\b(call|invoke|run)\b.{0,40}\b(tool|agent|skill)\b/u,
  ]

  return dynamicPatterns.some(pattern => pattern.test(text))
}

/**
 * Create the `create_cronjob` agent tool
 */
export function createCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'create_cronjob',
    label: 'Create Cronjob',
    description:
      'Create a recurring scheduled task (cronjob). The task will run automatically on the given schedule. ' +
      'Convert the user\'s natural language schedule description into a standard cron expression (5 fields: minute hour day-of-month month day-of-week). ' +
      'Examples: "every day at 9:00" → "0 9 * * *", "every 15 minutes" → "*/15 * * * *", "weekdays at 14:30" → "30 14 * * 1-5". ' +
      'Use action_type "injection" only for lightweight static messages (reminders, notifications, simple alerts) that should be delivered 1:1 with no agent run. ' +
      'Use action_type "task" (default) whenever the scheduled action must think, use tools/skills, fetch current data, check status, analyze something, or produce a fresh result at run time. If unsure, choose "task".',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Detailed prompt describing what the cronjob should do on each run. For action_type "task", make this self-contained and include the goal, constraints, and expected output. For action_type "injection", this must be a static message delivered verbatim. If the run should fetch current data, use tools/skills, or perform work first, use action_type "task" instead.',
      }),
      name: Type.String({
        description: 'Short, descriptive name for the cronjob (e.g., "Daily News Summary", "Hourly Health Check")',
      }),
      schedule: Type.String({
        description: 'Cron expression (5 fields: minute hour day-of-month month day-of-week). Example: "0 9 * * *" for every day at 9:00.',
      }),
      action_type: Type.Optional(
        Type.String({
          description: 'Type of action: "task" (default) spawns a full background agent. "injection" only delivers a static message verbatim into the main chat (lightweight, no agent spawned). Use "task" for current data, tool/skill usage, checks, analysis, or any dynamic work.',
        })
      ),
      provider: Type.Optional(
        Type.String({
          description: 'Provider name or id to use for this cronjob (e.g. "Kimi.ai", "OpenAI"). Choose the most appropriate provider based on the descriptions in `<available_providers>`. You may autonomously select a model that matches the task\'s needs. Only pass this if you have a specific reason to deviate from the default task model. Can be combined with `model` to pin both. Only relevant for action_type "task".',
        })
      ),
      model: Type.Optional(
        Type.String({
          description: 'Specific model id to use for this cronjob (e.g. "kimi-k2.6", "gpt-5", "claude-sonnet-4-5"). Choose based on the descriptions in `<available_providers>` — prefer cost-effective models for simple work and stronger models for complex coding or research. Only pass this if you have a specific reason to deviate from the default task model. If `provider` is omitted, the provider is auto-detected from the configured providers (requires a unique match). Only relevant for action_type "task".',
        })
      ),
      attached_skills: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional list of agent-skill names (directory names under /data/skills_agent/<name>/) whose SKILL.md should be injected directly into the task prompt on each run. Use this to bake skill rules into the prompt deterministically instead of requiring the task agent to read_file them at run time. Only relevant for action_type "task". Example: ["nitter", "reddit"]. Missing SKILL.md files are skipped with a warning, the task still runs.',
        })
      ),
      agent_id: Type.Optional(
        Type.String({
          description: 'Persona agent ID this cronjob belongs to (e.g. "warren"). Defaults to the current persona. Only specify to override.',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { prompt, name, schedule, action_type, provider, model, attached_skills, agent_id } = params as {
        prompt: string
        name: string
        schedule: string
        action_type?: string
        provider?: string
        model?: string
        attached_skills?: string[]
        agent_id?: string
      }

      try {
        // Validate cron expression
        const validationError = validateCronExpression(schedule)
        if (validationError) {
          return {
            content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${schedule}". ${validationError}` }],
            details: { error: true },
          }
        }

        // Validate action_type
        const actionType: ScheduledTaskActionType = action_type === 'injection' ? 'injection' : 'task'

        // Resolve provider + model into the composite `providerId:modelId`
        // form used everywhere else (settings, task-scheduler, UI).
        const providerResolved = resolveCronjobProviderValue(provider, model)
        if (!providerResolved.ok) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${providerResolved.error}` }],
            details: { error: true },
          }
        }
        const providerValue = providerResolved.value
        const providerLabel = providerResolved.label

        const normalizedAttachedSkills = normalizeAttachedSkills(attached_skills)

        // Resolve agentId: explicit param > current persona > 'main'
        const resolvedAgentId = agent_id ?? options.getCurrentAgentId?.() ?? 'main'

        // Create in DB
        const scheduledTask = options.taskRuntime.create({
          name,
          prompt,
          schedule,
          actionType,
          provider: providerValue,
          enabled: true,
          attachedSkills: normalizedAttachedSkills && normalizedAttachedSkills.length > 0 ? normalizedAttachedSkills : undefined,
          // Fork multi-persona: attribute the cronjob's spawned task to the persona.
          agentId: resolvedAgentId,
        })

        // Register with scheduler
        options.taskRuntime.register(scheduledTask)

        const humanSchedule = cronToHumanReadable(schedule)

        const actionLabel = actionType === 'injection' ? 'Injection (lightweight)' : 'Task (full agent)'

        const attachedSkillsLine = scheduledTask.attachedSkills && scheduledTask.attachedSkills.length > 0
          ? `Attached skills: ${scheduledTask.attachedSkills.join(', ')}\n`
          : ''

        return {
          content: [{
            type: 'text' as const,
            text: `Cronjob created successfully.\n\nID: ${scheduledTask.id}\nName: ${name}\nSchedule: ${humanSchedule} (${schedule})\nAction: ${actionLabel}\nAgent: ${resolvedAgentId}\n${providerLabel ? `Provider: ${providerLabel}\n` : ''}${attachedSkillsLine}Status: Enabled\n\nThe cronjob is now active and will run on the specified schedule.`,
          }],
          details: {
            cronjobId: scheduledTask.id,
            name,
            schedule,
            humanSchedule,
            actionType,
            agentId: resolvedAgentId,
            provider: providerValue ?? null,
            providerLabel,
            attachedSkills: scheduledTask.attachedSkills ?? null,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error creating cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `edit_cronjob` agent tool
 */
export function editCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'edit_cronjob',
    label: 'Edit Cronjob',
    description:
      'Edit an existing cronjob. You can update the prompt, name, schedule, action_type, provider, or enabled status. ' +
      'Only provide the fields you want to change.',
    parameters: Type.Object({
      id: Type.String({
        description: 'The ID of the cronjob to edit.',
      }),
      prompt: Type.Optional(
        Type.String({
          description: 'New prompt for the cronjob.',
        })
      ),
      name: Type.Optional(
        Type.String({
          description: 'New name for the cronjob.',
        })
      ),
      schedule: Type.Optional(
        Type.String({
          description: 'New cron expression (5 fields).',
        })
      ),
      action_type: Type.Optional(
        Type.String({
          description: 'Change action type: "task" or "injection".',
        })
      ),
      provider: Type.Optional(
        Type.String({
          description: 'New provider name or id for the cronjob (e.g. "Kimi.ai"). Pair with `model` to change both at once.',
        })
      ),
      model: Type.Optional(
        Type.String({
          description: 'New model id for the cronjob (e.g. "kimi-k2.6"). If `provider` is omitted, the provider is auto-detected from the configured providers (requires a unique match).',
        })
      ),
      enabled: Type.Optional(
        Type.Boolean({
          description: 'Enable or disable the cronjob.',
        })
      ),
      attached_skills: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Replace the list of agent skills attached to this cronjob. Pass an array of skill names (directory names under /data/skills_agent/<name>/). Pass an empty array [] to clear all attached skills. Omit to leave unchanged.',
        })
      ),
      agent_id: Type.Optional(
        Type.String({
          description: 'Change the persona agent ID this cronjob belongs to.',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { id, prompt, name, schedule, action_type, provider, model, enabled, attached_skills, agent_id } = params as {
        id: string
        prompt?: string
        name?: string
        schedule?: string
        action_type?: string
        provider?: string
        model?: string
        enabled?: boolean
        attached_skills?: string[]
        agent_id?: string
      }

      try {
        // Check exists
        const existing = options.taskRuntime.getById(id)
        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `Error: Cronjob "${id}" not found.` }],
            details: { error: true },
          }
        }

        // Validate schedule if provided
        if (schedule) {
          const validationError = validateCronExpression(schedule)
          if (validationError) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${schedule}". ${validationError}` }],
              details: { error: true },
            }
          }
        }

        // Validate action_type if provided
        const actionType: ScheduledTaskActionType | undefined = action_type
          ? (action_type === 'injection' ? 'injection' : 'task')
          : undefined

        // Resolve provider/model update (only when at least one was passed).
        // When neither is passed we must leave the field untouched (`undefined`
        // means "no change" in the store update API), not reset it.
        let providerUpdate: string | undefined
        if (provider !== undefined || model !== undefined) {
          const providerResolved = resolveCronjobProviderValue(provider, model)
          if (!providerResolved.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${providerResolved.error}` }],
              details: { error: true },
            }
          }
          // `resolveCronjobProviderValue` returns `undefined` only when both
          // inputs are empty — that branch is unreachable here because the
          // outer condition requires at least one to be defined.
          providerUpdate = providerResolved.value
        }

        // `undefined` leaves the list unchanged; `[]` explicitly clears it.
        const attachedSkillsUpdate = attached_skills === undefined
          ? undefined
          : normalizeAttachedSkills(attached_skills)

        // Update in DB
        const updated = options.taskRuntime.update(id, {
          prompt,
          name,
          schedule,
          actionType,
          provider: providerUpdate,
          enabled,
          attachedSkills: attachedSkillsUpdate,
          agentId: agent_id,
        })

        if (!updated) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to update cronjob "${id}".` }],
            details: { error: true },
          }
        }

        // Re-register with scheduler
        options.taskRuntime.register(updated)

        const humanSchedule = cronToHumanReadable(updated.schedule)

        const actionLabel = updated.actionType === 'injection' ? 'Injection (lightweight)' : 'Task (full agent)'

        const attachedSkillsText = updated.attachedSkills && updated.attachedSkills.length > 0
          ? updated.attachedSkills.join(', ')
          : 'none'

        return {
          content: [{
            type: 'text' as const,
            text: `Cronjob updated successfully.\n\nID: ${updated.id}\nName: ${updated.name}\nSchedule: ${humanSchedule} (${updated.schedule})\nAction: ${actionLabel}\nAgent: ${updated.agentId}\nProvider: ${updated.provider ?? 'default'}\nAttached skills: ${attachedSkillsText}\nStatus: ${updated.enabled ? 'Enabled' : 'Disabled'}`,
          }],
          details: {
            cronjobId: updated.id,
            name: updated.name,
            schedule: updated.schedule,
            humanSchedule,
            actionType: updated.actionType,
            agentId: updated.agentId,
            provider: updated.provider,
            enabled: updated.enabled,
            attachedSkills: updated.attachedSkills ?? null,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error editing cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `remove_cronjob` agent tool
 */
export function removeCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'remove_cronjob',
    label: 'Remove Cronjob',
    description: 'Delete an existing cronjob. This permanently removes the scheduled task.',
    parameters: Type.Object({
      id: Type.String({
        description: 'The ID of the cronjob to delete.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { id } = params as { id: string }

      try {
        // Check exists
        const existing = options.taskRuntime.getById(id)
        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `Error: Cronjob "${id}" not found.` }],
            details: { error: true },
          }
        }

        // Unregister from scheduler
        options.taskRuntime.unregister(id)

        // Delete from DB
        const deleted = options.taskRuntime.delete(id)
        if (!deleted) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to delete cronjob "${id}".` }],
            details: { error: true },
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Cronjob "${existing.name}" (${id}) has been deleted.`,
          }],
          details: {
            cronjobId: id,
            name: existing.name,
            deleted: true,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error removing cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `list_cronjobs` agent tool
 */
export function listCronjobsTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'list_cronjobs',
    label: 'List Cronjobs',
    description:
      'List all configured cronjobs with their schedules, status, and upcoming run times. ' +
      'Use this to answer questions like "which cronjobs are active?", "what runs tomorrow morning?", ' +
      'or "show me all scheduled tasks". Optionally compute the next N run times for each cronjob. ' +
      'To read the full prompt of a specific cronjob, use get_cronjob with its ID.',
    parameters: Type.Object({
      enabled_only: Type.Optional(
        Type.Boolean({
          description: 'If true, only show enabled cronjobs. Default: false (show all).',
        })
      ),
      next_runs: Type.Optional(
        Type.Number({
          description: 'Number of upcoming run times to compute for each cronjob (default: 3, max: 10).',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { enabled_only, next_runs } = params as {
        enabled_only?: boolean
        next_runs?: number
      }

      try {
        const cronjobs = enabled_only
          ? options.taskRuntime.listEnabled()
          : options.taskRuntime.list()

        if (cronjobs.length === 0) {
          return {
            content: [{ type: 'text' as const, text: enabled_only
              ? 'No enabled cronjobs found.'
              : 'No cronjobs configured.'
            }],
            details: { count: 0 },
          }
        }

        const numRuns = Math.min(Math.max(next_runs ?? 3, 1), 10)
        const now = new Date()

        const lines = cronjobs.map(cj => {
          const humanSchedule = cronToHumanReadable(cj.schedule)
          const status = cj.enabled ? 'ENABLED' : 'DISABLED'

          // Compute next run times
          let nextRunsStr = ''
          if (cj.enabled) {
            try {
              const fields = parseCronExpression(cj.schedule)
              const runs: string[] = []
              let cursor = new Date(now.getTime() - 60000) // start from now
              for (let i = 0; i < numRuns; i++) {
                const next = getNextRunTime(fields, cursor)
                if (!next) break
                runs.push(next.toISOString().replace('T', ' ').slice(0, 16) + ' UTC')
                cursor = next
              }
              if (runs.length > 0) {
                nextRunsStr = `\n  Next runs: ${runs.join(', ')}` 
              }
            } catch {
              // Skip if cron parse fails
            }
          }

          const lastRun = cj.lastRunAt
            ? `${cj.lastRunStatus ?? 'unknown'} at ${cj.lastRunAt}`
            : 'never'

          const actionLabel = cj.actionType === 'injection' ? 'injection' : 'task'
          const attachedSkillsLine = cj.attachedSkills && cj.attachedSkills.length > 0
            ? `\n  Attached skills: ${cj.attachedSkills.join(', ')}`
            : ''

          return `\u2022 [${status}] ${cj.name}\n  ID: ${cj.id}\n  Schedule: ${humanSchedule} (${cj.schedule})\n  Action: ${actionLabel}\n  Agent: ${cj.agentId}\n  Provider: ${cj.provider ?? 'default'}${attachedSkillsLine}\n  Last run: ${lastRun}${nextRunsStr}`
        })

        return {
          content: [{ type: 'text' as const, text: `Found ${cronjobs.length} cronjob(s):\n\n${lines.join('\n\n')}` }],
          details: { count: cronjobs.length },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error listing cronjobs: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `create_reminder` agent tool — a convenient shortcut for injection-type cronjobs
 */
export function getCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'get_cronjob',
    label: 'Get Cronjob',
    description:
      'Get the full configuration of a single cronjob by ID, including its complete prompt. ' +
      'Use this when you need to read or verify the prompt of an existing cronjob.',
    parameters: Type.Object({
      id: Type.String({
        description: 'The ID of the cronjob to retrieve.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { id } = params as { id: string }

      try {
        const cj = options.taskRuntime.getById(id)
        if (!cj) {
          return {
            content: [{ type: 'text' as const, text: `No cronjob found with ID: ${id}` }],
            details: { error: true },
          }
        }

        const humanSchedule = cronToHumanReadable(cj.schedule)
        const status = cj.enabled ? 'ENABLED' : 'DISABLED'
        const actionLabel = cj.actionType === 'injection' ? 'injection' : 'task'
        const lastRun = cj.lastRunAt
          ? `${cj.lastRunStatus ?? 'unknown'} at ${cj.lastRunAt}`
          : 'never'

        const attachedSkillsText = cj.attachedSkills && cj.attachedSkills.length > 0
          ? cj.attachedSkills.join(', ')
          : 'none'

        const text = [
          `[${status}] ${cj.name}`,
          `ID: ${cj.id}`,
          `Schedule: ${humanSchedule} (${cj.schedule})`,
          `Action: ${actionLabel}`,
          `Agent: ${cj.agentId}`,
          `Provider: ${cj.provider ?? 'default'}`,
          `Attached skills: ${attachedSkillsText}`,
          `Last run: ${lastRun}`,
          ``,
          `Prompt:`,
          cj.prompt,
        ].join('\n')

        return {
          content: [{ type: 'text' as const, text }],
          details: { cronjob: cj },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error retrieving cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

export function createReminderTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'create_reminder',
    label: 'Create Reminder',
    description:
      'Create a scheduled reminder that will be injected into the chat at the specified time. ' +
      'Important: this delivers a static message verbatim. No agent is spawned, no tools are used, no skills are loaded, and no fresh data is fetched at run time. ' +
      'Convert the user\'s desired time into a cron expression. ' +
      'For one-time reminders, use a specific date/time cron (e.g., "30 11 30 3 *" for March 30 at 11:30). ' +
      'For recurring reminders, use a repeating cron (e.g., "0 9 * * 1-5" for weekday mornings). ' +
      'Use this tool only when the user wants a literal reminder/notification/ping. If the scheduled action should check something, fetch current information, use a skill/tool, analyze data, or generate a fresh response at run time, do NOT use create_reminder — use create_cronjob with action_type "task" instead.',
    parameters: Type.Object({
      message: Type.String({
        description: 'The exact reminder message to deliver verbatim to the user. This must be static text, not instructions for a future agent run.',
      }),
      name: Type.String({
        description: 'Short name for the reminder (e.g., "Pack bags reminder", "Daily standup alert")',
      }),
      schedule: Type.String({
        description: 'Cron expression (5 fields: minute hour day-of-month month day-of-week). Example: "30 14 * * *" for every day at 14:30.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { message, name, schedule } = params as {
        message: string
        name: string
        schedule: string
      }

      try {
        if (looksLikeDynamicTaskRequest(name, message)) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: create_reminder only supports static reminder text delivered verbatim. This request looks dynamic (for example checking current data, using a skill/tool, or doing work at run time). Use create_cronjob with action_type "task" instead.',
            }],
            details: { error: true, suggestedActionType: 'task' },
          }
        }

        // Validate cron expression
        const validationError = validateCronExpression(schedule)
        if (validationError) {
          return {
            content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${schedule}". ${validationError}` }],
            details: { error: true },
          }
        }

        // Create injection-type scheduled task
        const scheduledTask = options.taskRuntime.create({
          name,
          prompt: message,
          schedule,
          actionType: 'injection',
          enabled: true,
        })

        // Register with scheduler
        options.taskRuntime.register(scheduledTask)

        const humanSchedule = cronToHumanReadable(schedule)

        // Compute next run time
        let nextRunStr = ''
        try {
          const fields = parseCronExpression(schedule)
          const nextRun = getNextRunTime(fields)
          if (nextRun) {
            nextRunStr = `\nNext delivery: ${nextRun.toISOString().replace('T', ' ').slice(0, 16)} UTC`
          }
        } catch {
          // skip
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Reminder created successfully.\n\nID: ${scheduledTask.id}\nName: ${name}\nSchedule: ${humanSchedule} (${schedule})\nMessage: ${message}${nextRunStr}\n\nThe reminder will be injected into the chat at the scheduled time.`,
          }],
          details: {
            cronjobId: scheduledTask.id,
            name,
            schedule,
            humanSchedule,
            actionType: 'injection',
            message,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error creating reminder: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}
