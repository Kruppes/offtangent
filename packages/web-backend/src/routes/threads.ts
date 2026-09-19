/**
 * /api/threads — named, parallel conversations per persona (Offtangent
 * Stufe 1). A thread IS an interactive session row; this router is the read/
 * write surface the Home inbox and the thread view are built on.
 *
 * Contract (frozen, the frontend is built against it):
 *   GET   /api/threads?agent_id=&include_archived=0|1&limit=50&offset=0
 *                     &project_id=<id>|none
 *           -> { threads: Thread[] }  (last activity first)
 *   POST  /api/threads          { agentId, title?, projectId? } -> 201 { thread }
 *   PATCH /api/threads/:id      { title?, pinned?, archived?, projectId? } -> { thread }
 *           404 for unknown or foreign threads, 400 `project_not_found`
 *           for a project that is unknown, foreign or archived.
 *   DELETE /api/threads/:id     -> 204, only for threads without messages
 *           404 unknown/foreign, 409 { code: 'thread_not_empty' } otherwise.
 *   GET   /api/threads/:id/context-stats
 *           -> { stats: { sessionId, promptTokens, completionTokens, cacheRead,
 *                         cacheWrite, cacheReadRatio, summaryVersion } }
 *           (SPEC 11.5 prompt cache measurement per strand) 404 unknown/foreign
 */
import { Router } from 'express'
import type { Response } from 'express'
import type { AgentCore } from '@axiom/core'
import { isProjectNotFoundError, getSessionCacheStats, getLatestSessionSummary, getDatabase } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { resolveAgentId } from '../persona-request.js'

export interface ThreadsRouterOptions {
  /** Resolves the live AgentCore (and via it, the SessionManager). */
  getAgentCore?: () => AgentCore | null
}

/** Parse an optional boolean-ish query flag ('1', 'true', 'yes'). */
function parseFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

/**
 * Parse `?project_id=`: absent/empty = no filter (`undefined`), the literal
 * `none` = threads WITHOUT a project (`null`), anything else = that project.
 */
function parseProjectFilter(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  if (raw === 'none') return null
  return raw
}

/**
 * A thread pointed at a project it may not use. Unknown / foreign / archived
 * are indistinguishable on purpose (no existence oracle).
 */
function sendProjectNotFound(res: Response): void {
  res.status(400).json({ error: 'Project not found', code: 'project_not_found' })
}

export function createThreadsRouter(options: ThreadsRouterOptions = {}): Router {
  const getAgentCore = options.getAgentCore ?? (() => null)
  const router = Router()

  router.use(jwtMiddleware)

  /** Threads live in the SessionManager; without an agent core there are none. */
  function sessionManager(): ReturnType<AgentCore['getSessionManager']> | null {
    return getAgentCore()?.getSessionManager() ?? null
  }

  router.get('/', (req: AuthenticatedRequest, res) => {
    const manager = sessionManager()
    if (!manager) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }

    // `?agent_id=` (present but empty) means "every persona", not 'main'.
    // Clients that build the query string from an empty filter state would
    // otherwise silently get main's threads only. The WS frames keep the
    // legacy '' -> 'main' mapping for old clients, so `resolveAgentId` itself
    // is deliberately NOT changed.
    const rawAgentId = req.query.agent_id
    const agentId = rawAgentId === undefined || rawAgentId === ''
      ? undefined
      : resolveAgentId(rawAgentId)
    if (agentId === null) {
      res.status(400).json({ error: 'Unknown agent_id' })
      return
    }

    const rawLimit = parseInt(String(req.query.limit ?? ''), 10)
    const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
    const rawOffset = parseInt(String(req.query.offset ?? ''), 10)
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)

    const projectFilter = parseProjectFilter(req.query.project_id)
    const threads = manager.listThreads(String(req.user!.userId), {
      agentId,
      includeArchived: parseFlag(req.query.include_archived),
      limit,
      offset,
      ...(projectFilter !== undefined ? { projectId: projectFilter } : {}),
    })
    res.json({ threads })
  })

  router.post('/', (req: AuthenticatedRequest, res) => {
    const manager = sessionManager()
    if (!manager) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }

    const agentId = resolveAgentId(req.body?.agentId)
    if (agentId === null) {
      res.status(400).json({ error: 'Unknown agentId' })
      return
    }
    const rawTitle = req.body?.title
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' })
      return
    }
    const rawProjectId = req.body?.projectId
    if (rawProjectId !== undefined && rawProjectId !== null && typeof rawProjectId !== 'string') {
      res.status(400).json({ error: 'projectId must be a string or null' })
      return
    }

    try {
      const thread = manager.createThread(
        String(req.user!.userId),
        agentId,
        rawTitle ?? null,
        rawProjectId ?? null,
      )
      res.status(201).json({ thread })
    } catch (err) {
      if (isProjectNotFoundError(err)) {
        sendProjectNotFound(res)
        return
      }
      throw err
    }
  })

  router.patch('/:id', (req: AuthenticatedRequest, res) => {
    const manager = sessionManager()
    if (!manager) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }

    const { title, pinned, archived, projectId } = req.body ?? {}
    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' })
      return
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      res.status(400).json({ error: 'pinned must be a boolean' })
      return
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' })
      return
    }
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      res.status(400).json({ error: 'projectId must be a string or null' })
      return
    }

    // A foreign or unknown thread is indistinguishable on purpose: both 404.
    let thread
    try {
      thread = manager.updateThread(String(req.user!.userId), String(req.params.id), {
        ...(title !== undefined ? { title } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      })
    } catch (err) {
      if (isProjectNotFoundError(err)) {
        sendProjectNotFound(res)
        return
      }
      throw err
    }
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' })
      return
    }
    res.json({ thread })
  })

  /** Prompt cache measurement per strand (SPEC 11.5). */
  router.get('/:id/context-stats', (req: AuthenticatedRequest, res) => {
    const manager = sessionManager()
    if (!manager) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }
    const thread = manager.getThread(String(req.user!.userId), String(req.params.id))
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' })
      return
    }
    const db = getDatabase()
    const stats = getSessionCacheStats(db, thread.id)
    const summary = getLatestSessionSummary(db, thread.id)
    res.json({ stats: { ...(stats ?? { sessionId: thread.id, promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheWrite: 0, cacheReadRatio: null }), summaryVersion: summary?.version ?? 0 } })
  })

  /**
   * Only threads that were created by accident (no messages at all) can be
   * deleted. Anything with content is archived instead — destroying it would
   * drop chat history that the daily summaries already refer to.
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    const manager = sessionManager()
    if (!manager) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }

    const result = manager.deleteThread(String(req.user!.userId), String(req.params.id))
    if (result === 'not_found') {
      res.status(404).json({ error: 'Thread not found' })
      return
    }
    if (result === 'not_empty') {
      res.status(409).json({ error: 'Thread is not empty; archive it instead', code: 'thread_not_empty' })
      return
    }
    res.status(204).end()
  })

  return router
}
