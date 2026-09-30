import { Router } from 'express'
import type { Database, TaskRuntimeScheduleBoundary } from '@axiom/core'
import { ScheduledTaskStore, validateCronExpression, cronToHumanReadable, loadSkills, listAgentSkills } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface CronjobsRouterOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeScheduleBoundary | null
  /**
   * Returns the tool names currently available to background task agents.
   * Injected from the runtime composition so the cronjob UI can render a
   * live list of toggleable tools instead of a hardcoded copy.
   */
  getBackgroundTaskToolNames?: () => string[]
}

export function createCronjobsRouter(options: CronjobsRouterOptions): Router {
  const router = Router()
  const store = new ScheduledTaskStore(options.db)

  const getTaskRuntime = (): TaskRuntimeScheduleBoundary | null => options.getTaskRuntime?.() ?? null

  router.use(jwtMiddleware)

  /**
   * GET /api/cronjobs/meta
   * Returns the live lists used by the cronjob form's "Advanced Configuration"
   * section: tool names the task agent can run, installed skills (so users can
   * disable them per-cronjob), and agent skills (so users can attach their
   * SKILL.md verbatim to the task prompt).
   *
   * Kept as a single round-trip so opening the dialog stays snappy.
   */
  router.get('/meta', (_req: AuthenticatedRequest, res) => {
    try {
      const tools = options.getBackgroundTaskToolNames?.() ?? []

      let installedSkills: Array<{ id: string; name: string; description: string; emoji?: string; enabled: boolean }> = []
      try {
        const file = loadSkills()
        installedSkills = file.skills.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          emoji: s.emoji,
          enabled: s.enabled,
        }))
      } catch {
        installedSkills = []
      }

      let agentSkills: Array<{ name: string; description: string }> = []
      try {
        agentSkills = listAgentSkills().map(s => ({ name: s.name, description: s.description }))
      } catch {
        agentSkills = []
      }

      res.json({
        tools,
        installedSkills,
        agentSkills,
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to load cronjob meta: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/cronjobs
   * Returns all scheduled tasks
   */
  router.get('/', (_req: AuthenticatedRequest, res) => {
    try {
      const taskRuntime = getTaskRuntime()
      const cronjobs = taskRuntime ? taskRuntime.list() : store.list()

      // Enrich with human-readable schedule
      const enriched = cronjobs.map(cj => ({
        ...cj,
        scheduleHuman: cronToHumanReadable(cj.schedule),
      }))

      res.json({ cronjobs: enriched })
    } catch (err) {
      res.status(500).json({ error: `Failed to list cronjobs: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/cronjobs
   * Creates a new scheduled task
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    try {
      const { name, prompt, schedule, actionType, provider, enabled, attachedSkills } = req.body as {
        name?: string
        prompt?: string
        schedule?: string
        actionType?: string
        provider?: string
        enabled?: boolean
        attachedSkills?: string[] | null
      }

      if (!name || !prompt || !schedule) {
        res.status(400).json({ error: 'Missing required fields: name, prompt, schedule' })
        return
      }

      // Validate cron expression
      const validationError = validateCronExpression(schedule)
      if (validationError) {
        res.status(400).json({ error: `Invalid cron expression: ${validationError}` })
        return
      }

      // Validate attachedSkills if provided
      let normalizedAttachedSkills: string[] | null | undefined = undefined
      if (attachedSkills !== undefined) {
        if (attachedSkills === null) {
          normalizedAttachedSkills = null
        } else if (!Array.isArray(attachedSkills) || !attachedSkills.every((v: unknown) => typeof v === 'string')) {
          res.status(400).json({ error: 'attachedSkills must be an array of strings' })
          return
        } else {
          normalizedAttachedSkills = Array.from(new Set(
            attachedSkills.map(v => v.trim()).filter(v => v.length > 0),
          ))
          if (normalizedAttachedSkills.length === 0) normalizedAttachedSkills = null
        }
      }

      const taskRuntime = getTaskRuntime()
      const cronjob = taskRuntime
        ? taskRuntime.create({
            name,
            prompt,
            schedule,
            actionType: actionType === 'injection' ? 'injection' : 'task',
            provider: provider || undefined,
            enabled: enabled !== undefined ? enabled : true,
            attachedSkills: normalizedAttachedSkills,
          })
        : store.create({
            name,
            prompt,
            schedule,
            actionType: actionType === 'injection' ? 'injection' : 'task',
            provider: provider || undefined,
            enabled: enabled !== undefined ? enabled : true,
            attachedSkills: normalizedAttachedSkills,
          })

      // Register with scheduler boundary when available
      if (taskRuntime) {
        taskRuntime.register(cronjob)
      }

      res.status(201).json({
        cronjob: {
          ...cronjob,
          scheduleHuman: cronToHumanReadable(cronjob.schedule),
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to create cronjob: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/cronjobs/:id
   * Updates a scheduled task
   */
  router.put('/:id', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const taskRuntime = getTaskRuntime()
      const existing = taskRuntime ? taskRuntime.getById(id) : store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      const { name, prompt, schedule, actionType, provider, enabled, toolsOverride, skillsOverride, systemPromptOverride, attachedSkills } = req.body as {
        name?: string
        prompt?: string
        schedule?: string
        actionType?: string
        provider?: string
        enabled?: boolean
        toolsOverride?: string | null
        skillsOverride?: string | null
        systemPromptOverride?: string | null
        attachedSkills?: string[] | null
      }

      // Validate cron expression if provided
      if (schedule) {
        const validationError = validateCronExpression(schedule)
        if (validationError) {
          res.status(400).json({ error: `Invalid cron expression: ${validationError}` })
          return
        }
      }

      // Validate override JSON formats
      if (toolsOverride !== undefined && toolsOverride !== null) {
        try {
          const parsed = JSON.parse(toolsOverride)
          if (!Array.isArray(parsed) || !parsed.every((v: unknown) => typeof v === 'string')) {
            res.status(400).json({ error: 'toolsOverride must be a JSON array of strings' })
            return
          }
        } catch {
          res.status(400).json({ error: 'toolsOverride must be valid JSON' })
          return
        }
      }

      if (skillsOverride !== undefined && skillsOverride !== null) {
        try {
          const parsed = JSON.parse(skillsOverride)
          if (!Array.isArray(parsed) || !parsed.every((v: unknown) => typeof v === 'string')) {
            res.status(400).json({ error: 'skillsOverride must be a JSON array of strings' })
            return
          }
        } catch {
          res.status(400).json({ error: 'skillsOverride must be valid JSON' })
          return
        }
      }

      if (systemPromptOverride !== undefined && systemPromptOverride !== null && typeof systemPromptOverride !== 'string') {
        res.status(400).json({ error: 'systemPromptOverride must be a string' })
        return
      }

      // Validate + normalize attachedSkills if provided
      let attachedSkillsUpdate: string[] | null | undefined = undefined
      if (attachedSkills !== undefined) {
        if (attachedSkills === null) {
          attachedSkillsUpdate = null
        } else if (!Array.isArray(attachedSkills) || !attachedSkills.every((v: unknown) => typeof v === 'string')) {
          res.status(400).json({ error: 'attachedSkills must be an array of strings' })
          return
        } else {
          const normalized = Array.from(new Set(
            attachedSkills.map(v => v.trim()).filter(v => v.length > 0),
          ))
          attachedSkillsUpdate = normalized.length === 0 ? null : normalized
        }
      }

      const updated = taskRuntime
        ? taskRuntime.update(id, {
            name,
            prompt,
            schedule,
            actionType: actionType !== undefined ? (actionType === 'injection' ? 'injection' : 'task') : undefined,
            provider,
            enabled,
            toolsOverride: toolsOverride !== undefined ? toolsOverride : undefined,
            skillsOverride: skillsOverride !== undefined ? skillsOverride : undefined,
            systemPromptOverride: systemPromptOverride !== undefined ? systemPromptOverride : undefined,
            attachedSkills: attachedSkillsUpdate,
          })
        : store.update(id, {
            name,
            prompt,
            schedule,
            actionType: actionType !== undefined ? (actionType === 'injection' ? 'injection' : 'task') : undefined,
            provider,
            enabled,
            toolsOverride: toolsOverride !== undefined ? toolsOverride : undefined,
            skillsOverride: skillsOverride !== undefined ? skillsOverride : undefined,
            systemPromptOverride: systemPromptOverride !== undefined ? systemPromptOverride : undefined,
            attachedSkills: attachedSkillsUpdate,
          })

      if (!updated) {
        res.status(500).json({ error: 'Failed to update cronjob' })
        return
      }

      // Re-register with scheduler boundary when available
      if (taskRuntime) {
        taskRuntime.register(updated)
      }

      res.json({
        cronjob: {
          ...updated,
          scheduleHuman: cronToHumanReadable(updated.schedule),
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update cronjob: ${(err as Error).message}` })
    }
  })

  /**
   * DELETE /api/cronjobs/:id
   * Deletes a scheduled task
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const taskRuntime = getTaskRuntime()
      const existing = taskRuntime ? taskRuntime.getById(id) : store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      // Unregister from scheduler boundary when available
      if (taskRuntime) {
        taskRuntime.unregister(id)
      }

      const deleted = taskRuntime ? taskRuntime.delete(id) : store.delete(id)
      if (!deleted) {
        res.status(500).json({ error: 'Failed to delete cronjob' })
        return
      }

      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete cronjob: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/cronjobs/:id/trigger
   * Manually triggers a cronjob (runs it immediately via Task Runner)
   */
  router.post('/:id/trigger', async (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const taskRuntime = getTaskRuntime()
      const existing = taskRuntime ? taskRuntime.getById(id) : store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      if (!taskRuntime) {
        res.status(503).json({ error: 'Task scheduler not available' })
        return
      }

      const taskId = await taskRuntime.triggerNow(id)
      if (!taskId) {
        res.status(500).json({ error: 'Failed to trigger cronjob' })
        return
      }

      res.json({ taskId, message: `Cronjob "${existing.name}" triggered successfully.` })
    } catch (err) {
      res.status(500).json({ error: `Failed to trigger cronjob: ${(err as Error).message}` })
    }
  })

  return router
}
