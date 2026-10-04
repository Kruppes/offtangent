/**
 * Strands, tags, now set and resurface (SPEC 6.2, 6.3). Four routers built
 * from one service so they share the session manager lookup:
 *
 *   GET  /api/strands?tag=&now=1&agent_id=&project_id=&include_archived=&limit=&offset=
 *             &attention=1&unread=1&q=
 *        -> { strands: Strand[] }   Strand = Thread + { tags, nowRank, links }
 *        `q` searches the strand title (substring, LIKE with `%`/`_`/`\`
 *        escaped) and the user/assistant messages of the strand (FTS5 index
 *        `chat_messages_fts`, every word a prefix term, all words required;
 *        without a usable index or for a query without word characters an
 *        escaped, parameterised `LIKE` substring match on the message text).
 *        Trimmed length 2..200, otherwise 400 `invalid_q`; blank = no search.
 *        It resolves to an id set like the chips, so it combines with every
 *        other filter, keeps the list order (pinned, then latest activity)
 *        and paginates with limit/offset exactly. A strand found through a
 *        message carries `matchSnippet`: a plain-text excerpt (no markup) of
 *        its best ranked matching message. Title-only hits have none.
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
 *   POST /api/strands/:id/activity/dismiss { ids } -> { dismissed, dismissedAt }
 *   POST /api/strands/:id/activity/undismiss { ids } -> { restored }
 *        (W6c) acknowledge finished entries of the activity list; ids must
 *        belong to the strand's task tree (404), live ones are refused (409).
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
 *        W5b, additive: `recalled: [{ messageId, strandId, role, excerpt,
 *        recalledAt, source: 'recall'|'context' }]`, the older messages the
 *        agent pulled back (recall_message / strand-context retrieval),
 *        newest first, at most 20, excerpt <= 160 chars, owner scoped.
 *   GET  /api/strands/:id/facts
 *        -> { strandId, facts: [{ id, text, createdAt, status }], total, truncated,
 *             summaries, toolCalls }
 *        Slim fact list of the context panel (W5b), at most 200, oldest first.
 *        404 strand_not_found for a foreign or unknown strand.
 *   POST /api/strands/:id/fork { messageId, title? }
 *        -> 201 { strand: StrandDetail, fork: { strandId, title, parentStrandId,
 *           parentTitle, forkedAt, forkedFromMessageId, seedMessageId,
 *           noticeMessageId, depth } }
 *        "Fork at this message" (W5b), the `fork_strand` mechanism: seed =
 *        the message (<= 4000 chars) + `[msg:<id>]`, no turn starts.
 *        400 invalid_body / invalid_message_id / invalid_title / message_empty,
 *        404 strand_not_found / message_not_found (message of another strand
 *        or not a user/assistant row), 409 strand_archived /
 *        fork_depth_exceeded, 429 fork_rate_limited (20 per minute).
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
import { perUserRateLimit } from '../../rate-limit.js'

/** Web forks per user and minute; a fork is a human click, not a loop. */
export const FORK_PER_MINUTE = 20
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
  strands.patch('/:id/eco', controller.patchStrandEco)
  strands.get('/:id/tasks', controller.strandTasks)
  strands.get('/:id/context', controller.strandContext)
  strands.get('/:id/facts', controller.strandFacts)
  strands.post('/:id/fork', perUserRateLimit({ windowMs: 60_000, max: FORK_PER_MINUTE, code: 'fork_rate_limited' }), controller.forkStrand)
  strands.patch('/:id', controller.patchStrand)
  strands.delete('/:id', controller.deleteStrand)
  strands.put('/:id/tags', controller.setStrandTags)
  strands.post('/:id/project-suggestion/accept', controller.acceptProjectSuggestion)
  strands.post('/:id/project-suggestion/dismiss', controller.dismissProjectSuggestion)
  strands.post('/:id/activity/dismiss', controller.dismissActivity)
  strands.post('/:id/activity/undismiss', controller.undismissActivity)

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
