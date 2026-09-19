import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from './database.js'
import type { EmailAccount } from './email-account-store.js'
import type { EmailClient, EmailSendInput } from './email-client.js'
import { createEmailSendLogEntry, getEmailSendLogEntry, initEmailSendLogTable } from './email-send-log.js'
import type { CreateEmailSendLogInput, EmailSendLogEntry } from './email-send-log.js'
import {
  clearEmailApprovalNotifiers,
  notifyEmailApprovalRequested,
  registerEmailApprovalNotifier,
} from './email-approval-notifier.js'
import { createEmailApprovalService, recoverStuckApprovedEmails } from './email-approval.js'

const ACCOUNT: EmailAccount = {
  id: 'acc-1',
  name: 'Work',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapUser: 'agent@example.com',
  imapPassword: 'imap',
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpUser: 'agent@example.com',
  smtpPassword: 'smtp',
  imapSecurity: 'ssl',
  smtpSecurity: 'ssl',
  allowSelfSignedCert: false,
  canSend: true,
  canManage: false,
  canDelete: false,
  canDownloadAttachments: false,
  requireApproval: true,
  allowlist: { addresses: [], domains: [] },
  folderMode: 'all',
  allowedFolders: [],
  displayName: 'Agent',
  signature: 'Sent by an AI agent',
  appendToSentFolder: true,
  allowHtml: false,
  attachmentDownloadPath: 'email-attachments',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function makeInput(overrides: Partial<CreateEmailSendLogInput> = {}): CreateEmailSendLogInput {
  return {
    accountId: 'acc-1',
    accountName: 'Work',
    status: 'pending',
    to: ['stranger@partner.org'],
    subject: 'Quarterly numbers',
    bodyText: 'All good.\n\n-- \nSent by an AI agent',
    reason: 'Recipient outside the allowlist',
    ...overrides,
  }
}

describe('email approval', () => {
  let db: Database
  let sent: EmailSendInput[]
  let sendMessage: ReturnType<typeof vi.fn>

  function service(overrides: { client?: Partial<EmailClient>; account?: EmailAccount | null } = {}) {
    return createEmailApprovalService({
      db,
      client: { sendMessage, ...overrides.client } as unknown as EmailClient,
      getAccount: () => (overrides.account === undefined ? ACCOUNT : overrides.account),
    })
  }

  function seed(overrides: Partial<CreateEmailSendLogInput> = {}): EmailSendLogEntry {
    return createEmailSendLogEntry(db, makeInput(overrides))
  }

  beforeEach(() => {
    db = new BetterSqlite3(':memory:') as unknown as Database
    initEmailSendLogTable(db)
    sent = []
    sendMessage = vi.fn(async (_account: unknown, input: EmailSendInput) => {
      sent.push(input)
      return { messageId: '<sent-1@example.com>', accepted: input.to, rejected: [], appendedToSent: true }
    })
    clearEmailApprovalNotifiers()
  })

  afterEach(() => {
    clearEmailApprovalNotifiers()
    db.close()
  })

  it('sends the stored message on approve and records the decider', async () => {
    const entry = seed({
      cc: ['cc@partner.org'],
      bcc: ['archive@example.com'],
      bodyHtml: '<p>All good.</p>',
      inReplyTo: '<orig@example.com>',
      references: ['<orig@example.com>'],
      attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf', size: 10 }],
    })

    const result = await service().approve(entry.id, { name: 'alice' })

    expect(result.ok).toBe(true)
    expect(result.entry!.status).toBe('sent')
    expect(result.entry!.decidedBy).toBe('alice')
    expect(result.entry!.decidedAt).toBeTruthy()
    expect(result.entry!.sentAt).toBeTruthy()
    expect(result.entry!.messageId).toBe('<sent-1@example.com>')

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: ['stranger@partner.org'],
      cc: ['cc@partner.org'],
      bcc: ['archive@example.com'],
      subject: 'Quarterly numbers',
      text: 'All good.\n\n-- \nSent by an AI agent',
      html: '<p>All good.</p>',
      inReplyTo: '<orig@example.com>',
      references: ['<orig@example.com>'],
      attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf' }],
      appendToSentFolder: true,
    })
  })

  it('rejects without sending and records the decider', async () => {
    const entry = seed()

    const result = await service().reject(entry.id, { name: 'bob' })

    expect(result.ok).toBe(true)
    expect(result.entry!.status).toBe('rejected')
    expect(result.entry!.decidedBy).toBe('bob')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('lets only the first of two concurrent approvals win', async () => {
    const entry = seed()
    const approval = service()

    const [first, second] = await Promise.all([
      approval.approve(entry.id, { name: 'alice' }),
      approval.approve(entry.id, { name: 'bob' }),
    ])

    const winners = [first, second].filter(r => r.ok)
    const losers = [first, second].filter(r => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ code: 'already_decided' })
    expect(losers[0]!.message).toContain('already decided')
    expect(sendMessage).toHaveBeenCalledTimes(1)

    const stored = getEmailSendLogEntry(db, entry.id)!
    expect(stored.status).toBe('sent')
    expect(stored.decidedBy).toBe('alice')
  })

  it('lets approve win over a competing reject', async () => {
    const entry = seed()
    const approval = service()

    const approved = await approval.approve(entry.id, { name: 'alice' })
    const rejected = await approval.reject(entry.id, { name: 'bob' })

    expect(approved.ok).toBe(true)
    expect(rejected.ok).toBe(false)
    expect(rejected).toMatchObject({ code: 'already_decided', message: expect.stringContaining('alice') })
    expect(getEmailSendLogEntry(db, entry.id)!.decidedBy).toBe('alice')
  })

  it('marks the entry failed with the SMTP error and allows a retry', async () => {
    const entry = seed()
    sendMessage.mockRejectedValueOnce(new Error('SMTP connection refused'))

    const approval = service()
    const failed = await approval.approve(entry.id, { name: 'alice' })

    expect(failed.ok).toBe(false)
    expect(failed).toMatchObject({ code: 'send_failed' })
    expect(failed.entry!.status).toBe('failed')
    expect(failed.entry!.errorMessage).toBe('SMTP connection refused')
    expect(failed.entry!.decidedBy).toBe('alice')

    const retried = await approval.retry(entry.id, { name: 'bob' })

    expect(retried.ok).toBe(true)
    expect(retried.entry!.status).toBe('sent')
    expect(retried.entry!.errorMessage).toBeNull()
    expect(retried.entry!.decidedBy).toBe('bob')
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('does not auto-retry a failed entry', async () => {
    const entry = seed()
    sendMessage.mockRejectedValue(new Error('nope'))

    await service().approve(entry.id, { name: 'alice' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(getEmailSendLogEntry(db, entry.id)!.status).toBe('failed')
  })

  it('refuses to retry an entry that is not failed', async () => {
    const entry = seed()

    const result = await service().retry(entry.id, { name: 'alice' })

    expect(result).toMatchObject({ code: 'not_retryable' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('refuses to decide entries that never waited for approval', async () => {
    for (const status of ['sent', 'blocked', 'rejected', 'approved'] as const) {
      const entry = seed({ status })
      const result = await service().approve(entry.id, { name: 'alice' })
      expect(result).toMatchObject({ ok: false, code: 'already_decided' })
    }
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('reports unknown entries', async () => {
    const approval = service()
    expect(await approval.approve('nope', { name: 'alice' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await approval.reject('nope', { name: 'alice' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await approval.retry('nope', { name: 'alice' })).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('fails the entry when the account was deleted in the meantime', async () => {
    const entry = seed()

    const result = await service({ account: null }).approve(entry.id, { name: 'alice' })

    expect(result).toMatchObject({ ok: false, code: 'account_missing' })
    expect(result.entry!.status).toBe('failed')
    expect(result.entry!.errorMessage).toContain('no longer exists')
  })

  it('notifies registered channels about requests and decisions', async () => {
    const requested: string[] = []
    const resolvedStatuses: string[] = []
    registerEmailApprovalNotifier({
      approvalRequested: e => { requested.push(e.id) },
      approvalResolved: e => { resolvedStatuses.push(e.status) },
    })

    const entry = seed()
    await notifyEmailApprovalRequested(entry)
    await service().approve(entry.id, { name: 'alice' })
    const other = seed()
    await service().reject(other.id, { name: 'bob' })

    expect(requested).toEqual([entry.id])
    // The approve notification carries the send result, not the interim state.
    expect(resolvedStatuses).toEqual(['sent', 'rejected'])
  })

  it('notifies channels with the failure when the send blows up', async () => {
    const resolvedStatuses: string[] = []
    registerEmailApprovalNotifier({ approvalResolved: e => { resolvedStatuses.push(e.status) } })
    sendMessage.mockRejectedValueOnce(new Error('SMTP connection refused'))

    await service().approve(seed().id, { name: 'alice' })

    expect(resolvedStatuses).toEqual(['failed'])
  })

  it('recovers entries stuck in approved after a crash so they can be retried', async () => {
    const stuck = seed({ status: 'approved' })
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE email_send_log SET updated_at = ? WHERE id = ?').run(stale, stuck.id)
    const inFlight = seed({ status: 'approved' })

    expect(recoverStuckApprovedEmails(db)).toBe(1)
    expect(getEmailSendLogEntry(db, stuck.id)!.status).toBe('failed')
    expect(getEmailSendLogEntry(db, inFlight.id)!.status).toBe('approved')

    const retried = await service().retry(stuck.id, { name: 'alice' })
    expect(retried.ok).toBe(true)
    expect(retried.entry!.status).toBe('sent')
  })

  it('keeps working when a notifier throws', async () => {
    registerEmailApprovalNotifier({
      approvalResolved: () => { throw new Error('channel down') },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const entry = seed()
    const result = await service().approve(entry.id, { name: 'alice' })

    expect(result.ok).toBe(true)
    expect(result.entry!.status).toBe('sent')
    errorSpy.mockRestore()
  })
})
