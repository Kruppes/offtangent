import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { mapTaskEventsResponse, mapTaskResponse, mapTasksListResponse } from './mapper.js'
import { parseListTasksQuery, parseReplyTaskBody, parseRestartTaskBody, parseTaskEventsQuery, parseTaskIdParam } from './schema.js'
import type { TaskRequester } from './service.js'
import {
  TaskCannotBeKilledError,
  TaskCannotBeRestartedError,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskNotResumableError,
  TaskRestartProviderError,
  TaskRuntimeUnavailableError,
  type TasksService,
} from './service.js'

export interface TasksController {
  listTasks: (req: AuthenticatedRequest, res: Response) => void
  getTaskById: (req: AuthenticatedRequest, res: Response) => void
  getTaskEvents: (req: AuthenticatedRequest, res: Response) => void
  killTask: (req: AuthenticatedRequest, res: Response) => void
  replyToTask: (req: AuthenticatedRequest, res: Response) => Promise<void>
  restartTask: (req: AuthenticatedRequest, res: Response) => Promise<void>
}

/**
 * The identity every single-task endpoint is authorized against. `req.user`
 * is set by `jwtMiddleware` (the router mounts it before every route), so it
 * is present here; the fallback only exists so a missing middleware fails
 * closed instead of granting admin.
 */
function requesterOf(req: AuthenticatedRequest): TaskRequester {
  return { userId: req.user?.userId ?? -1, role: req.user?.role ?? 'user' }
}

export function createTasksController(service: TasksService): TasksController {
  return {
    listTasks(req, res) {
      try {
        const parsedQuery = parseListTasksQuery(req.query as Record<string, unknown>)
        if (!parsedQuery.ok) {
          res.status(400).json({ error: parsedQuery.error })
          return
        }

        const { tasks, total, providerOptions } = service.listTasks(parsedQuery.value)

        res.json(
          mapTasksListResponse({
            tasks,
            page: parsedQuery.value.page,
            limit: parsedQuery.value.limit,
            total,
            providerOptions,
          }),
        )
      } catch (err) {
        res.status(500).json({ error: `Failed to list tasks: ${(err as Error).message}` })
      }
    },

    getTaskById(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        // A task the requester may not see answers 404, exactly like a task
        // that does not exist — no existence oracle.
        const task = service.getTaskById(id, requesterOf(req))
        if (!task) {
          res.status(404).json({ error: 'Task not found' })
          return
        }

        // Chain cost (own + delegated sub-tasks) next to the row itself.
        res.json(mapTaskResponse(task, service.getTaskCost(id, requesterOf(req))))
      } catch (err) {
        res.status(500).json({ error: `Failed to get task: ${(err as Error).message}` })
      }
    },

    getTaskEvents(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const parsedQuery = parseTaskEventsQuery(req.query as Record<string, unknown>)
        if (!parsedQuery.ok) {
          // A bad cursor is refused, not ignored: answering with the whole
          // timeline would turn a client bug into megabytes per poll.
          res.status(400).json({ error: parsedQuery.error })
          return
        }

        const payload = service.getTaskEvents(id, requesterOf(req), { since: parsedQuery.value.since })
        res.json(mapTaskEventsResponse(payload))
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to get task events: ${(err as Error).message}` })
      }
    },

    killTask(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const task = service.killTask(id, requesterOf(req))
        res.json(mapTaskResponse(task))
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof TaskCannotBeKilledError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to kill task: ${(err as Error).message}` })
      }
    },

    /**
     * `POST /api/tasks/:id/reply` — the app's answer to a task message.
     * Status codes are the API contract of 2026-09-18: resumed 200,
     * running 409, follow-up 201, empty text 400, foreign task 403,
     * unknown task 404.
     */
    async replyToTask(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const parsed = parseReplyTaskBody(req.body)
        if (!parsed.ok) {
          res.status(400).json({ error: 'validation_error', message: parsed.error })
          return
        }

        const result = await service.replyToTask(id, parsed.value.text, requesterOf(req))
        const status = result.outcome === 'resumed' ? 200 : result.outcome === 'running' ? 409 : 201
        res.status(status).json(result)
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof TaskForbiddenError) {
          res.status(403).json({ error: err.message })
          return
        }

        if (err instanceof TaskNotResumableError) {
          res.status(409).json({ error: err.message })
          return
        }

        if (err instanceof TaskRuntimeUnavailableError) {
          res.status(503).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to reply to task: ${(err as Error).message}` })
      }
    },

    async restartTask(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const parsed = parseRestartTaskBody(req.body)
        if (!parsed.ok) {
          res.status(400).json({ error: parsed.error })
          return
        }

        const task = await service.restartTask(id, parsed.value, requesterOf(req))
        res.status(201).json(mapTaskResponse(task))
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof TaskCannotBeRestartedError) {
          res.status(409).json({ error: err.message })
          return
        }

        if (err instanceof TaskRestartProviderError) {
          res.status(400).json({ error: err.message })
          return
        }

        if (err instanceof TaskRuntimeUnavailableError) {
          res.status(503).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to restart task: ${(err as Error).message}` })
      }
    },
  }
}
