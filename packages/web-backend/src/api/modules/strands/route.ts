/**
 * Strands, tags, now set and resurface (SPEC 6.2, 6.3). Four routers built
 * from one service so they share the session manager lookup:
 *
 *   GET  /api/strands?tag=&now=1&agent_id=&project_id=&include_archived=&limit=&offset=
 *             &attention=1&unread=1
 *        -> { strands: Strand[] }   Strand = Thread + { tags, nowRank, links }
 *        `attention=1` / `unread=1` are server side filters (the two chips of
 *        plan 2026-09-26): the matching ids are resolved first and handed to
 *        the thread query, so order and pagination are unchanged. Both
 *        combine as AND. A value that is not a boolean is a 400.
 *   GET  /api/strands/attention-summary
 *        -> { awaiting, unread, firstAwaitingStrandId }
 *        Counted over ALL non-archived strands of the user, independent of the
 *        100-per-page cap of the list. `firstAwaitingStrandId` is the strand
 *        with the oldest open question.
 *   PATCH  /api/strands/:id { archived?, pinned?, title? } -> { strand }
 *   POST /api/strands/:id/read -> 204 (server side read state, idempotent)
 *        Every strand of the list and detail read carries `lastActivityAt`
 *        (newest non-user message), `unread` derived from it, and `attention`
 *        (the oldest open question of the strand, or null).
 *   POST /api/strands/:id/project-suggestion/accept  -> { strand }
 *   POST /api/strands/:id/project-suggestion/dismiss -> { strand }
 *        The running project assignment (Stufe 2): accept writes the proposed
 *        project, dismiss buries the (strand, project) pair for good.
 *        404 strand_not_found / suggestion_not_found, 409 project_already_set
 *   GET  /api/strands/:id/delete-preview -> { title, messages, captures, attachments, facts, ... }
 *   GET  /api/strands/:id/context
 *        -> { strandId, measurement, budget, lastCompaction, model, generatedAt }
 *        Context telemetry of THIS strand: the token counts the provider
 *        reported for the LAST request of this session (input + cache read +
 *        cache write), the current model's window/answer reserve and the
 *        runtime trim threshold. Unknown values are null, never 0. 404 for a
 *        foreign or unknown strand.
 *   GET  /api/strands/:id/tasks?include=active|all
 *        -> { strandId, include, tasks: StrandTaskNode[], activeCount, truncated, maxDepth, generatedAt }
 *        The delegated tasks of a strand and, recursively, their sub-tasks.
 *   DELETE /api/strands/:id?confirm=1&delete_facts=0 -> { deleted: {...} }
 *          400 confirm_required, 403 foreign strand, 409 strand_busy
 *   PUT  /api/strands/:id/tags { tags: string[] } -> { strand }
 *   GET  /api/tags?include_archived=0|1 -> { tags }
 *   POST /api/tags { name, color? } -> 201 { tag } (200 when the name exists)
 *   PATCH /api/tags/:id { name?, color?, archived? } -> { tag }
 *   GET  /api/now -> { strands, max, mode }. `max` is the effective now-set
 *        size (setting `offtangent.nowSetMax`, default 4), `mode` how the set
 *        is filled (setting `offtangent.nowSetMode`, default `auto`).
 *        `auto`: `strands` is computed from the user's activity
 *        (`rankStrandsByActivity`, pinned first, then distinct active days
 *        with a 1-day half-life over 14 days) and `nowRank` is the position
 *        in that computed list; the `now_set` table is never read or written.
 *        `manual`: the curated `now_set` table, ordered by its rank.
 *   PUT  /api/now { strandIds } -> { strands, max, mode }, 400
 *        now_set_too_large above `max`, 409 now_set_auto while the mode is
 *        `auto` (the set is computed, so there is nothing to write)
 *   GET  /api/resurface?limit=5 -> { items }
 *   POST /api/resurface/:strandId/snooze { days } -> 204
 */
import { Router } from 'express'
import type { AgentCore, Database, NowSetMode } from '@axiom/core'
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
  getNowSetMode?: () => NowSetMode
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
  // Literal paths first: `/:id` would otherwise match `attention-summary` and
  // answer 404 strand_not_found for it.
  strands.get('/attention-summary', controller.attentionSummary)
  strands.get('/:id/delete-preview', controller.deletePreview)
  strands.get('/:id', controller.getStrand)
  strands.post('/:id/read', controller.markStrandRead)
  strands.patch('/:id/model', controller.patchStrandModel)
  strands.get('/:id/tasks', controller.strandTasks)
  strands.get('/:id/context', controller.strandContext)
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
