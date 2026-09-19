import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database, TurnErrorInfo, TurnInfo } from '@axiom/core'
import {
  TURN_RETRY_ACTION_KIND,
  TURN_RETRY_RESOLUTIONS,
  buildTurnErrorMetadata,
  initDatabase,
  newTurnRetryActionId,
  notifyTurnRetryResolved,
} from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { ChatActionRegistry } from './chat-actions.js'
import type { ChatActionMessage } from './chat-actions.js'
import { registerTurnRetryChatChannel } from './turn-retry-chat.js'

const USER_ID = 2
const SESSION_ID = 'session-retry-chat'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

let chatActions: ChatActionRegistry
let published: { type: string; message: ChatActionMessage }[]
let retryTurn: ReturnType<typeof vi.fn>
let activeTurn: boolean
let unregisterChannel: (() => void) | null = null
let attachRetryAction: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void

function seedSession(endedAt: string | null = null): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(SESSION_ID)
  db.prepare(
    'INSERT INTO sessions (id, user_id, source, type, ended_at) VALUES (?, ?, ?, ?, ?)'
  ).run(SESSION_ID, USER_ID, 'web', 'interactive', endedAt)
}

function insertMessage(role: 'user' | 'assistant' | 'system', content: string, metadata?: string): number {
  const result = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(SESSION_ID, USER_ID, role, content, metadata ?? null)
  return Number(result.lastInsertRowid)
}

/** Mimics a failed turn: user message, persisted error row, registered button. */
function seedFailedTurn(): { errorMessageId: number; retryActionId: string } {
  insertMessage('user', 'summarize my inbox')
  const retryActionId = newTurnRetryActionId()
  const error: TurnErrorInfo = {
    cause: 'non_retryable',
    error: 'AuthenticationError: 401 invalid x-api-key',
    attempts: 0,
    retryable: false,
    occurredAt: new Date().toISOString(),
    retryActionId,
  }
  const errorMessageId = insertMessage(
    'system',
    `\u274C Provider error: ${error.error}`,
    JSON.stringify(buildTurnErrorMetadata(error)),
  )

  attachRetryAction({
    turn: {
      turnId: 'turn-1',
      agentUserId: String(USER_ID),
      userId: USER_ID,
      sessionId: SESSION_ID,
      agentId: 'main',
      startedAt: Date.now(),
    },
    error: { ...error, messageId: errorMessageId },
  })

  return { errorMessageId, retryActionId }
}

async function postAction(messageId: string, actionId = 'retry') {
  const res = await fetch(`${baseUrl}/api/chat/actions/${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId }),
  })
  return { res, body: await res.json() as { status?: string; resolution?: string; error?: string } }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-turn-retry-chat-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'alice', 'x')

  chatActions = new ChatActionRegistry({
    publishToClients: event => published.push({ type: event.type, message: { ...event.message } }),
  })

  server = http.createServer(createApp({ db, chatActions }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: USER_ID, username: 'alice', role: 'user' })
})

afterAll(async () => {
  unregisterChannel?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM chat_messages').run()
  published = []
  activeTurn = false
  retryTurn = vi.fn(() => ({
    turnId: 'turn-retry',
    agentUserId: String(USER_ID),
    userId: USER_ID,
    sessionId: SESSION_ID,
    startedAt: Date.now(),
  }))

  unregisterChannel?.()
  const channel = registerTurnRetryChatChannel({
    chatActions,
    db,
    runner: { hasActiveTurn: () => activeTurn, retryTurn: retryTurn as never },
  })
  attachRetryAction = channel.attachRetryAction
  unregisterChannel = channel.unregister
  seedSession()
})

describe('manual retry webchat channel', () => {
  it('re-runs the failed turn and broadcasts the resolution to every client', async () => {
    const { errorMessageId, retryActionId } = seedFailedTurn()

    // The button is attached to the persisted error row, not published as a
    // second bubble — the error message renders it itself.
    expect(published).toHaveLength(0)

    const { res, body } = await postAction(retryActionId)

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok', resolution: TURN_RETRY_RESOLUTIONS.started })
    expect(retryTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: SESSION_ID,
      text: 'summarize my inbox',
      source: 'web',
    })

    expect(published).toHaveLength(1)
    expect(published[0]!.type).toBe('chat_action_resolved')
    expect(published[0]!.message).toMatchObject({
      messageId: retryActionId,
      kind: TURN_RETRY_ACTION_KIND,
      refId: String(errorMessageId),
      resolution: TURN_RETRY_RESOLUTIONS.started,
    })
  })

  it('answers "no longer available" when a newer user message exists', async () => {
    const { retryActionId } = seedFailedTurn()
    insertMessage('user', 'actually, never mind')

    const { res, body } = await postAction(retryActionId)

    expect(res.status).toBe(409)
    expect(body.resolution).toBe(TURN_RETRY_RESOLUTIONS.movedOn)
    expect(retryTurn).not.toHaveBeenCalled()
    expect(published[published.length - 1]!.message.resolution).toBe(TURN_RETRY_RESOLUTIONS.movedOn)
  })

  it('answers "no longer available" when the session ended', async () => {
    const { retryActionId } = seedFailedTurn()
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', SESSION_ID)

    const { res, body } = await postAction(retryActionId)

    expect(res.status).toBe(409)
    expect(body.resolution).toBe(TURN_RETRY_RESOLUTIONS.sessionEnded)
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('answers "no longer available" for a button minted before a restart', async () => {
    // The registry is in-memory: an error row that survived the restart still
    // renders its button, but the id is unknown to the fresh process.
    seedFailedTurn()

    const { res, body } = await postAction(newTurnRetryActionId())

    expect(res.status).toBe(404)
    expect(body.error).toContain('no longer available')
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('disables the web button when another channel answered the retry', async () => {
    const { errorMessageId, retryActionId } = seedFailedTurn()

    // What the Telegram channel triggers when its inline button is tapped.
    await notifyTurnRetryResolved({
      errorMessageId,
      ok: true,
      resolution: TURN_RETRY_RESOLUTIONS.started,
    })

    expect(published).toHaveLength(1)
    expect(published[0]!.message).toMatchObject({
      messageId: retryActionId,
      refId: String(errorMessageId),
      resolution: TURN_RETRY_RESOLUTIONS.started,
    })

    // And the now-stale web button cannot start a second turn.
    insertMessage('assistant', 'the retried answer')
    const { res, body } = await postAction(retryActionId)
    expect(res.status).toBe(409)
    expect(body.resolution).toBe(TURN_RETRY_RESOLUTIONS.movedOn)
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('refuses a retry while another turn is already running', async () => {
    const { retryActionId } = seedFailedTurn()
    activeTurn = true

    const { res, body } = await postAction(retryActionId)

    expect(res.status).toBe(409)
    expect(body.resolution).toBe(TURN_RETRY_RESOLUTIONS.busy)
    expect(retryTurn).not.toHaveBeenCalled()
  })
})
