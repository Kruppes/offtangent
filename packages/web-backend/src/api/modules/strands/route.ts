/**
 * Strands, tags, now set and resurface (SPEC 6.2, 6.3). Four routers built
 * from one service so they share the session manager lookup:
 *
 *   GET  /api/strands?tag=&now=1&agent_id=&project_id=&include_archived=&limit=&offset=
 *        -> { strands: Strand[] }   Strand = Thread + { tags, nowRank, links }
 *   PATCH  /api/strands/:id { archived?, pinned?, title? } -> { strand }
 *   POST /api/strands/:id/read -> 204 (server side read state, idempotent)
 *        Every strand of the list and detail read carries `lastActivityAt`
 *        (newest non-user message) and `unread` derived from it.
 *   POST /api/strands/:id/project-suggestion/accept  -> { strand }
 *   POST /api/strands/:id/project-suggestion/dismiss -> { strand }
 *        The running project assignment (Stufe 2): accept writes the proposed
 *        project, dismiss buries the (strand, project) pair for good.
 *        404 strand_not_found / suggestion_not_found, 409 project_already_set
 *   GET  /api/strands/:id/delete-preview -> { title, messages, captures, attachments, facts, ... }
 *   GET  /api/strands/:id/tasks?include=active|all
 *        -> { strandId, include, tasks: StrandTaskNode[], activeCount, truncated, maxDepth, generatedAt }
 *        The delegated tasks of a strand and, recursively, their sub-tasks.
 *   DELETE /api/strands/:id?confirm=1&delete_facts=0 -> { deleted: {...} }
 *          400 confirm_required, 403 foreign strand, 409 strand_busy
 *   PUT  /api/strands/:id/tags { tags: string[] } -> { strand }
 *   GET  /api/tags?include_archived=0|1 -> { tags }
 *   POST /api/tags { name, color? } -> 201 { tag } (200 when the name exists)
 *   PATCH /api/tags/:id { name?, color?, archived? } -> { tag }
 *   GET  /api/now -> { strands } (by rank) + { max }, the effective now-set
 *        size (setting `offtangent.nowSetMax`, default 4)
 *   PUT  /api/now { strandIds } -> { strands, max }, 400 now_set_too_large
 *        above `max`
 *   GET  /api/resurface?limit=5 -> { items }
 *   POST /api/resurface/:strandId/snooze { days } -> 204
 */
import { Router } from 'express'
import type { AgentCore, Database } from '@axiom/core'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { jwtMiddleware } from '../../../auth.js'
import type { ChatEventBus } from '../../../chat-event-bus.js'
import { createStrandsController } from './controller.js'
import { createStrandsService, type StrandTurnGuard } from './service.js'

export interface StrandsRouterOptions {
  db: Database
  getAgentCore: () => AgentCore | null
  chatEventBus?: ChatEventBus | null
  getTurnRunner?: () => StrandTurnGuard | null
  getNowSetMax?: () => number
  getQuotaSnapshot?: () => Record<string, ProviderQuotaContract>
}

export interface StrandsRouters {
  strands: Router
  tags: Router
  now: Router
  resurface: Router
}

export function createStrandsRouters(options: StrandsRouterOptions): StrandsRouters {
  const service = createStrandsService(options)
  const controller = createStrandsController(service)

  const strands = Router()
  strands.use(jwtMiddleware)
  strands.get('/', controller.listStrands)
  strands.get('/:id/delete-preview', controller.deletePreview)
  strands.get('/:id', controller.getStrand)
  strands.post('/:id/read', controller.markStrandRead)
  strands.patch('/:id/model', controller.patchStrandModel)
  strands.get('/:id/tasks', controller.strandTasks)
  strands.patch('/:id', controller.patchStrand)
  strands.delete('/:id', controller.deleteStrand)
  strands.put('/:id/tags', controller.setStrandTags)
  strands.post('/:id/project-suggestion/accept', controller.acceptProjectSuggestion)
  strands.post('/:id/project-suggestion/dismiss', controller.dismissProjectSuggestion)

  const tags = Router()
  tags.use(jwtMiddleware)
  tags.get('/', controller.listTags)
  tags.post('/', controller.createTag)
  tags.patch('/:id', controller.patchTag)

  const now = Router()
  now.use(jwtMiddleware)
  now.get('/', controller.getNow)
  now.put('/', controller.putNow)

  const resurface = Router()
  resurface.use(jwtMiddleware)
  resurface.get('/', controller.resurface)
  resurface.post('/:strandId/snooze', controller.snooze)

  return { strands, tags, now, resurface }
}
