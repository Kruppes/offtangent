import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, EmailSendLogEntry } from '@axiom/core'
import {
  clearEmailApprovalNotifiers,
  createEmailSendLogEntry,
  initDatabase,
  notifyEmailApprovalRequested,
  notifyEmailApprovalResolved,
} from '@axiom/core'
import type { EmailApprovalResult, EmailApprovalService } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { ChatActionRegistry } from './chat-actions.js'
import type { ChatActionMessage } from './chat-actions.js'
import { EMAIL_APPROVAL_CHAT_KIND, registerEmailApprovalChatChannel } from './email-approval-chat.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

let chatActions: ChatActionRegistry
let published: { type: string; message: ChatActionMessage }[]
let decisions: { action: string; id: string; decider: string }[]
let unregisterChannel: (() => void) | null = null

/** Mimics the core service: first decision wins, later ones are rejected. */
function fakeApprovalService(): EmailApprovalService {
  const decided = new Set<string>()

  function decide(action: 'approve' | 'reject', id: string, decider: string): EmailApprovalResult {
    const entry = seedEntry({ id })
    if (decided.has(id)) {
      return { ok: false, code: 'already_decided', message: 'This email was already decided.', entry }
    }
    decided.add(id)
    decisions.push({ action, id, decider })
    return {
      ok: true,
      entry: {
        ...entry,
        status: action === 'approve' ? 'sent' : 'rejected',
        decidedBy: decider,
      },
    }
  }

  return {
    approve: async (id, decider) => decide('approve', id, decider.name),
    reject: async (id, decider) => decide('reject', id, decider.name),
    retry: async () => { throw new Error('not used') },
  }
}

function seedEntry(overrides: Partial<EmailSendLogEntry> = {}): EmailSendLogEntry {
  const entry = createEmailSendLogEntry(db, {
    accountId: 'acc-1',
    accountName: 'Work',
    status: 'pending',
    to: ['stranger@partner.org'],
    subject: 'Quarterly numbers',
    bodyText: 'x'.repeat(600),
    reason: 'Recipient outside the allowlist',
    attachments: [{ filename: 'report.pdf', size: 2048, path: '/tmp/report.pdf' }],
  })
  return { ...entry, ...overrides }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chat-actions-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  chatActions = new ChatActionRegistry({
    publishToClients: event => published.push({ type: event.type, message: { ...event.message } }),
  })

  server = http.createServer(createApp({ db, chatActions }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 2, username: 'alice', role: 'user' })
})

afterAll(async () => {
  unregisterChannel?.()
  clearEmailApprovalNotifiers()
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM email_send_log').run()
  published = []
  decisions = []
  unregisterChannel?.()
  clearEmailApprovalNotifiers()
  unregisterChannel = registerEmailApprovalChatChannel({
    chatActions,
    approval: fakeApprovalService(),
  })
})

async function postAction(messageId: string, actionId: string, authToken = token) {
  const res = await fetch(`${baseUrl}/api/chat/actions/${messageId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId }),
  })
  return { res, body: await res.json() as { status?: string; resolution?: string; error?: string } }
}

function lastPublished(): ChatActionMessage {
  return published[published.length - 1]!.message
}

describe('email approval webchat channel', () => {
  it('publishes a truncated approval message with accept/cancel buttons', async () => {
    const entry = seedEntry()
    await notifyEmailApprovalRequested(entry)

    expect(published).toHaveLength(1)
    const message = lastPublished()
    expect(published[0]!.type).toBe('chat_action')
    expect(message.kind).toBe(EMAIL_APPROVAL_CHAT_KIND)
    expect(message.refId).toBe(entry.id)
    expect(message.actions.map(a => a.actionId)).toEqual(['approve', 'reject'])
    expect(message.text).toContain('stranger@partner.org')
    expect(message.text).toContain('Quarterly numbers')
    expect(message.text).toContain('report.pdf (2.0 KB)')
    expect(message.text).toContain('\u2026')
    expect(message.text).not.toContain('x'.repeat(500))
  })

  it('ignores entries that are not pending', async () => {
    await notifyEmailApprovalRequested(seedEntry({ status: 'sent' }))
    expect(published).toHaveLength(0)
  })

  it('runs the approval through the endpoint and resolves the buttons', async () => {
    const entry = seedEntry()
    await notifyEmailApprovalRequested(entry)
    const message = lastPublished()

    const { res, body } = await postAction(message.messageId, 'approve')

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.resolution).toContain('Approved by alice')
    expect(decisions).toEqual([{ action: 'approve', id: entry.id, decider: 'alice' }])
    expect(published[published.length - 1]!.type).toBe('chat_action_resolved')
    expect(lastPublished().resolution).toContain('Approved by alice')
  })

  it('keeps first-action-wins: the second click gets the already-decided answer', async () => {
    await notifyEmailApprovalRequested(seedEntry())
    const message = lastPublished()

    await postAction(message.messageId, 'approve')
    const { res, body } = await postAction(message.messageId, 'reject')

    expect(res.status).toBe(409)
    expect(body.error).toContain('already decided')
    expect(decisions).toHaveLength(1)
  })

  it('invalidates the buttons when another channel decided', async () => {
    const entry = seedEntry()
    await notifyEmailApprovalRequested(entry)

    await notifyEmailApprovalResolved({ ...entry, status: 'rejected', decidedBy: 'bob' })

    const event = published[published.length - 1]!
    expect(event.type).toBe('chat_action_resolved')
    expect(event.message.messageId).toBe(lastPublished().messageId)
    expect(event.message.resolution).toBe('\uD83D\uDEAB Rejected by bob')
    expect(decisions).toHaveLength(0)
  })

  it('rejects unknown messages and missing action ids', async () => {
    const unknown = await postAction('cam-does-not-exist', 'approve')
    expect(unknown.res.status).toBe(404)

    await notifyEmailApprovalRequested(seedEntry())
    const message = lastPublished()

    const missing = await postAction(message.messageId, '')
    expect(missing.res.status).toBe(400)

    const bogus = await postAction(message.messageId, 'explode')
    expect(bogus.res.status).toBe(404)
    expect(decisions).toHaveLength(0)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/chat/actions/cam-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: 'approve' }),
    })
    expect(res.status).toBe(401)
  })
})
