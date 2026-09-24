import { Router } from 'express'
import type { Database, AgentCore } from '@axiom/core'
import { saveUploadFromFile, resolveStoredUpload, serializeUploadsMetadata, listLoadableSkills, listArtifactsForMessages, toIsoUtc } from '@axiom/core'
import type { UploadDescriptor } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { uploadArray, getMaxUploadFiles, cleanupRequestUploads } from '../uploads.js'
import type { ChatActionRegistry } from '../chat-actions.js'
import { normalizeClientMessageId, normalizeSessionId, resolveAgentId } from '../persona-request.js'
import { isSessionAccessError } from '@axiom/core'
import { extractDraftText } from '@axiom/core/contracts'
// Artifact projection shared with `/api/artifacts` so both endpoints agree.
import { toArtifactRef } from '../api/modules/artifacts/schema.js'
import { withDerivedTaskResultPreviews } from '../task-result-preview.js'

/**
 * Every message row leaves this router with an unambiguous timestamp.
 *
 * `chat_messages.timestamp` is stored as `2026-09-15 06:15:53` — UTC, but
 * without a zone marker, so a client that parses it with `new Date(...)` reads
 * it as local time and is hours off. `timestamp` therefore carries the
 * normalized ISO-8601 UTC value, and `timestampUtc` repeats it under a name
 * that states the contract for new clients (see
 * `/data/memory/plans/2026-09-15-ot-chronology-fix.md` for the migration path).
 */
function withIsoTimestamp<T extends Record<string, unknown>>(row: T): T & { timestampUtc: string } {
  const iso = toIsoUtc(String(row.timestamp ?? ''))
  return { ...row, timestamp: iso, timestampUtc: iso }
}

/** Contract mapping of the explicit-thread refusals onto HTTP status codes. */
const SESSION_ERROR_STATUS: Record<string, number> = {
  session_not_found: 404,
  session_agent_mismatch: 409,
  session_forbidden: 403,
}

/**
 * Ceiling for one message, counted over uploaded AND already-stored
 * attachments. Mirrors the multipart limit (`UPLOAD_MAX_FILES`), so the two
 * sources cannot be combined to get past it.
 */
function maxAttachmentsPerMessage(): number {
  return getMaxUploadFiles()
}

/**
 * Attachments the caller does not upload again because the server already
 * stored them (today: the recording of `POST /api/stt/transcribe?keepAudio=1`).
 * The body carries the descriptors as a JSON string, each one is re-derived
 * from the file on disk before it is trusted.
 *
 * Returns `null` when the field is malformed or points at something that is
 * not a stored upload, so the caller can answer 400 instead of silently
 * dropping an attachment the user can see on their screen.
 */
function parseStoredAttachments(raw: unknown): UploadDescriptor[] | null {
  if (raw === undefined || raw === null || raw === '') return []
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  const out: UploadDescriptor[] = []
  for (const entry of parsed) {
    const resolved = resolveStoredUpload(entry)
    if (!resolved) return null
    out.push(resolved)
  }
  return out
}

/** Columns returned by every history query (kept in one place so both branches stay identical). */
const HISTORY_SELECT = `SELECT cm.id, cm.session_id, cm.user_id, cm.role, cm.content, cm.metadata, cm.timestamp,
                cm.agent_id, cm.client_message_id,
                s.source AS source, s.type AS session_type
         FROM chat_messages cm
         LEFT JOIN sessions s ON s.id = cm.session_id`

export interface ChatRouterOptions {
  db: Database
  /** Backs the interactive action buttons rendered inside chat messages. */
  chatActions?: ChatActionRegistry | null
  /** Resolves the live AgentCore (and via it, SessionManager). May return null
   * if the agent isn't available yet — in which case the REST upload endpoint
   * cannot create a tracked session and will return an error. */
  getAgentCore?: () => AgentCore | null
}

export function createChatRouter(options: ChatRouterOptions): Router {
  const { db } = options
  const getAgentCore = options.getAgentCore ?? (() => null)
  const router = Router()

  router.use(jwtMiddleware)

  router.post('/message', uploadArray('files'), (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId
    const text = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    // Every early return below leaves streamed part files behind otherwise.
    const abort = (status: number, body: Record<string, unknown>): void => {
      cleanupRequestUploads(req)
      res.status(status).json(body)
    }

    const storedAttachments = parseStoredAttachments(req.body?.attachments)
    if (storedAttachments === null) {
      abort(400, { error: 'attachments must be a JSON array of stored upload descriptors' })
      return
    }

    if (!text && files.length === 0 && storedAttachments.length === 0) {
      abort(400, { error: 'Message content or at least one file is required' })
      return
    }

    if (files.length + storedAttachments.length > maxAttachmentsPerMessage()) {
      abort(400, { error: `At most ${maxAttachmentsPerMessage()} attachments per message`, code: 'too_many_files' })
      return
    }

    // Fork multi-persona (Axiom-Companion M1): optional persona + idempotency key.
    const agentId = resolveAgentId(req.body?.agentId)
    if (agentId === null) {
      abort(400, { error: 'Unknown agentId' })
      return
    }
    const clientMessageId = normalizeClientMessageId(req.body?.clientMessageId)
    if (clientMessageId === null) {
      abort(400, { error: 'Invalid clientMessageId' })
      return
    }
    // Offtangent Stufe 1: optional explicit thread (multipart field, like agentId).
    const explicitSessionId = normalizeSessionId(req.body?.sessionId)
    if (explicitSessionId === null) {
      abort(400, { error: 'Invalid sessionId' })
      return
    }

    // Resolve a tracked interactive session via SessionManager. Source is
    // 'web' — this REST endpoint is the upload prelude for a WebSocket chat
    // message, so the session belongs to the web channel. Using 'rest' here
    // would leak into the cached session and mistag subsequent WS messages
    // (the cache keeps the initial source), corrupting source-based filters
    // in chat history, logs, and usage stats.
    const agentCore = getAgentCore()
    if (!agentCore) {
      abort(503, { error: 'Agent core not available' })
      return
    }
    // Idempotent retry: the row already exists, hand it back unchanged (200,
    // not 201) and do NOT store the re-uploaded files a second time.
    if (clientMessageId) {
      const existing = db.prepare(
        'SELECT id, session_id, user_id, role, content, metadata, timestamp, agent_id, client_message_id FROM chat_messages WHERE user_id = ? AND client_message_id = ?'
      ).get(userId, clientMessageId) as Record<string, unknown> | undefined
      if (existing) {
        if (existing.agent_id !== agentId) {
          abort(409, { error: 'clientMessageId already used for another persona' })
          return
        }
        // The re-uploaded bytes are not stored a second time — drop the parts.
        cleanupRequestUploads(req)
        res.status(200).json({ message: withIsoTimestamp(existing), duplicate: true })
        return
      }
    }

    let sessionId: string
    if (explicitSessionId) {
      try {
        // Guards only; activation happens in the turn (see ws-chat).
        sessionId = agentCore.getSessionManager().assertSessionAccess(String(userId), explicitSessionId, agentId).id
      } catch (err) {
        if (isSessionAccessError(err)) {
          abort(SESSION_ERROR_STATUS[err.code] ?? 400, { error: err.message, code: err.code })
          return
        }
        cleanupRequestUploads(req)
        throw err
      }
    } else {
      sessionId = agentCore.getSessionManager().getOrCreateSession(String(userId), 'web', agentId).id
    }

    // Stored attachments come first: a voice message is the recording with its
    // transcript underneath, not the other way round.
    const uploads = [
      ...storedAttachments,
      ...files.map(file => saveUploadFromFile({
        sourcePath: file.path,
        originalName: file.originalname,
        mimeType: file.mimetype,
        source: 'web',
        userId,
        sessionId,
      })),
    ]

    const metadata = uploads.length > 0 ? serializeUploadsMetadata(uploads) : null
    let insertedId: number
    try {
      const result = db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, client_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, userId, 'user', text, metadata, agentId, clientMessageId ?? null)
      insertedId = Number(result.lastInsertRowid)
    } catch (err) {
      // Two concurrent retries with the same key: the loser reads the winner.
      cleanupRequestUploads(req)
      if (clientMessageId && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const existing = db.prepare(
          'SELECT id, session_id, user_id, role, content, metadata, timestamp, agent_id, client_message_id FROM chat_messages WHERE user_id = ? AND client_message_id = ?'
        ).get(userId, clientMessageId) as Record<string, unknown>
        res.status(200).json({ message: withIsoTimestamp(existing), duplicate: true })
        return
      }
      throw err
    }

    // Read the stored value back instead of inventing one: the row the client
    // gets here must be the row it later sees in the history, to the second.
    const storedTimestamp = (db.prepare('SELECT timestamp FROM chat_messages WHERE id = ?')
      .get(insertedId) as { timestamp: string } | undefined)?.timestamp

    res.status(201).json({
      message: withIsoTimestamp({
        id: insertedId,
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: text,
        metadata,
        timestamp: storedTimestamp ?? new Date().toISOString(),
        agent_id: agentId,
        client_message_id: clientMessageId ?? null,
      }),
    })
  })

  /**
   * GET /api/chat/history
   * Query: ?session_id=xxx&page=1&limit=50[&agent_id=bob][&since_id=123]
   * Returns paginated chat messages, joined with `sessions` so each message
   * carries the originating `source` (web, telegram, rest, ...). The frontend
   * uses `source` instead of inferring from session-ID prefixes.
   *
   * Fork (Axiom-Companion M1), both optional and additive:
   * - `agent_id` restricts to one persona.
   * - `since_id` switches to cursor mode: rows with `id > since_id`, ordered
   *   ASCENDING by id, so a reconnecting client fetches exactly the gap it
   *   missed. `page` is ignored in cursor mode; `limit` still caps the batch
   *   and `pagination.total` is the number of rows after the cursor.
   *
   * Offtangent (SPEC 7.4b): every message carries its canvas artifacts as
   * `artifacts: ArtifactRef[]` (empty when it has none), so no client has to
   * re-parse the markdown to find out whether a message opens a canvas.
   *
   * Puck assist waves (W1): every message also carries `draft: string | null`,
   * the plain text of its `draft` block (SPEC 7.4c wire format) or null. The
   * device that types the draft over a BLE keyboard must not have to run a
   * markdown parser to find it, and it must not guess which part of an answer
   * was prose. `content` is untouched — exactly like every other block kind,
   * the fence stays in the message and each surface degrades it itself — so no
   * existing field changes meaning.
   */
  router.get('/history', (req: AuthenticatedRequest, res) => {
    const sessionId = req.query.session_id as string | undefined
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50))
    const offset = (page - 1) * limit
    const userId = req.user!.userId

    const agentId = req.query.agent_id === undefined ? undefined : resolveAgentId(req.query.agent_id)
    if (agentId === null) {
      res.status(400).json({ error: 'Unknown agent_id' })
      return
    }
    let sinceId: number | undefined
    if (req.query.since_id !== undefined) {
      const raw = String(req.query.since_id)
      if (!/^\d{1,15}$/.test(raw)) {
        res.status(400).json({ error: 'since_id must be a non-negative integer' })
        return
      }
      sinceId = Number(raw)
    }

    const where: string[] = ['cm.user_id = ?']
    const params: unknown[] = [userId]
    if (sessionId) {
      where.push('cm.session_id = ?')
      params.push(sessionId)
    }
    if (agentId !== undefined) {
      where.push('cm.agent_id = ?')
      params.push(agentId)
    }
    if (sinceId !== undefined) {
      where.push('cm.id > ?')
      params.push(sinceId)
    }
    const whereSql = where.join(' AND ')

    const messages = sinceId !== undefined
      ? db.prepare(`${HISTORY_SELECT} WHERE ${whereSql} ORDER BY cm.id ASC LIMIT ?`).all(...params, limit)
      // `cm.id` is the tiebreaker: `cm.timestamp` has second resolution, so
      // rows written in the same second come back in an undefined order — and
      // the frontend reverses this page straight into the transcript.
      : db.prepare(`${HISTORY_SELECT} WHERE ${whereSql} ORDER BY cm.timestamp DESC, cm.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)

    const total = (db.prepare(
      `SELECT COUNT(*) as count FROM chat_messages cm WHERE ${whereSql}`
    ).get(...params) as { count: number }).count

    // Task-result rows from before the card format carry the whole report in
    // `content` (the longest one on the live database is 20,342 characters).
    // They get their card derived here instead of migrated, so no client has
    // to download a wall of text for a report it renders collapsed anyway.
    const rows = withDerivedTaskResultPreviews(db, messages as Array<Record<string, unknown>>)
    const byMessage = listArtifactsForMessages(db, userId, rows.map(row => Number(row.id)))
    const withArtifacts = rows.map(row => withIsoTimestamp({
      ...row,
      artifacts: (byMessage.get(Number(row.id)) ?? []).map(toArtifactRef),
      // Only an assistant message can carry a draft: a draft is something the
      // persona wrote for the user to type, and a fence a user typed himself
      // is his own text, not a draft the device should send back to him.
      draft: row.role === 'assistant' ? extractDraftText(String(row.content ?? '')) : null,
    }))

    res.json({
      messages: withArtifacts,
      pagination: {
        page: sinceId !== undefined ? 1 : page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  })

  /**
   * POST /api/chat/actions/:messageId
   * Body: { actionId }
   * Answers a button of an interactive chat message. The registered handler
   * owns the decision semantics (including first-action-wins), so a stale
   * click just loses there and gets the handler's message back.
   */
  router.post('/actions/:messageId', async (req: AuthenticatedRequest, res) => {
    const registry = options.chatActions
    if (!registry) {
      res.status(503).json({ error: 'Chat actions are not available' })
      return
    }

    const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId.trim() : ''
    if (!actionId) {
      res.status(400).json({ error: 'actionId is required' })
      return
    }

    const user = req.user!

    try {
      const result = await registry.invoke(String(req.params.messageId), actionId, {
        userId: user.userId,
        username: user.username,
      })

      if (result.status === 'not_found') {
        res.status(404).json({ error: 'This action is no longer available.' })
        return
      }

      if (result.status === 'ok') {
        res.json({ status: result.status, resolution: result.resolution })
        return
      }

      // `error` mirrors the resolution so generic API clients surface the
      // reason (e.g. "already decided") instead of a bare status code.
      res.status(409).json({ status: result.status, resolution: result.resolution, error: result.resolution })
    } catch (err) {
      res.status(500).json({ error: `Failed to run chat action: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/chat/sessions
   * Returns list of chat sessions for the current user
   */
  router.get('/sessions', (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId

    const sessions = db.prepare(`
      SELECT DISTINCT session_id,
        MIN(timestamp) as started_at,
        MAX(timestamp) as last_message_at,
        COUNT(*) as message_count
      FROM chat_messages
      WHERE user_id = ?
      GROUP BY session_id
      ORDER BY last_message_at DESC, session_id DESC
    `).all(userId) as Array<Record<string, unknown>>

    // Both aggregates come straight from `chat_messages.timestamp`, so they
    // carry the same naked-UTC ambiguity and get normalized like every other
    // timestamp on the wire.
    res.json({
      sessions: sessions.map(session => ({
        ...session,
        started_at: toIsoUtc(String(session.started_at ?? '')),
        last_message_at: toIsoUtc(String(session.last_message_at ?? '')),
      })),
    })
  })

  /**
   * GET /api/chat/skills
   * Skills the current user can load via `/skill:<id>` (composer autocomplete).
   * Deliberately not admin-gated: every chat user may load skills.
   */
  router.get('/skills', (_req: AuthenticatedRequest, res) => {
    try {
      res.json({ skills: listLoadableSkills() })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
