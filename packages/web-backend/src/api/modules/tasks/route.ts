import { Router } from 'express'
import type { Database, ProviderConfig, TaskRuntimeTaskBoundary } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { ReplyToTask } from '../../../task-reply.js'
import { createTasksController } from './controller.js'
import { createTasksService } from './service.js'

export interface TasksRouterOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeTaskBoundary | null
  /** Look up a provider by id/name — needed for the restart endpoint. */
  resolveProvider?: (nameOrId: string) => ProviderConfig | null
  /** Configured task default provider — used when restart omits provider/model. */
  getDefaultProvider?: () => ProviderConfig | null
  /**
   * Answer a task (`POST /:id/reply`). Built once in the runtime composition
   * (see `task-reply.ts`) and handed in here — the same function the Telegram
   * reply path uses. Absent means the endpoint answers 503.
   */
  replyToTask?: ReplyToTask
}

export function createTasksRouter(options: TasksRouterOptions): Router {
  const router = Router()

  const service = createTasksService({
    db: options.db,
    getTaskRuntime: options.getTaskRuntime,
    resolveProvider: options.resolveProvider,
    getDefaultProvider: options.getDefaultProvider,
    replyToTask: options.replyToTask,
  })
  const controller = createTasksController(service)

  router.use(jwtMiddleware)

  router.get('/', controller.listTasks)
  router.get('/:id', controller.getTaskById)
  router.get('/:id/events', controller.getTaskEvents)
  router.post('/:id/kill', controller.killTask)
  router.post('/:id/reply', controller.replyToTask)
  router.post('/:id/restart', controller.restartTask)

  return router
}
