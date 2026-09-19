import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from './database.js'
import {
  countEmailSendLog,
  createEmailSendLogEntry,
  getEmailSendLogEntry,
  initEmailSendLogTable,
  listEmailSendLog,
  updateEmailSendLogEntry,
} from './email-send-log.js'
import type { CreateEmailSendLogInput } from './email-send-log.js'

function makeInput(overrides: Partial<CreateEmailSendLogInput> = {}): CreateEmailSendLogInput {
  return {
    accountId: 'acc-1',
    accountName: 'Work',
    status: 'sent',
    to: ['boss@example.com'],
    subject: 'Status report',
    bodyText: 'All good.',
    ...overrides,
  }
}

describe('email send log', () => {
  let db: Database

  beforeEach(() => {
    db = new BetterSqlite3(':memory:') as unknown as Database
    initEmailSendLogTable(db)
  })

  afterEach(() => {
    db.close()
  })

  it('persists the full message including attachments and thread headers', () => {
    const entry = createEmailSendLogEntry(db, makeInput({
      cc: ['cc@partner.org'],
      bcc: ['bcc@partner.org'],
      bodyHtml: '<p>All good.</p>',
      attachments: [{ filename: 'report.pdf', path: '/workspace/report.pdf', size: 1024 }],
      inReplyTo: '<orig@example.com>',
      references: ['<root@example.com>', '<orig@example.com>'],
      messageId: '<new@example.com>',
    }))

    const loaded = getEmailSendLogEntry(db, entry.id)
    expect(loaded).toEqual(entry)
    expect(loaded?.to).toEqual(['boss@example.com'])
    expect(loaded?.cc).toEqual(['cc@partner.org'])
    expect(loaded?.bcc).toEqual(['bcc@partner.org'])
    expect(loaded?.attachments).toEqual([{ filename: 'report.pdf', path: '/workspace/report.pdf', size: 1024 }])
    expect(loaded?.references).toEqual(['<root@example.com>', '<orig@example.com>'])
    expect(loaded?.bodyHtml).toBe('<p>All good.</p>')
    expect(loaded?.sentAt).toBeTruthy()
  })

  it('keeps sentAt empty for non-sent entries', () => {
    const entry = createEmailSendLogEntry(db, makeInput({ status: 'blocked', reason: 'not allowlisted' }))
    expect(entry.sentAt).toBeNull()
    expect(entry.reason).toBe('not allowlisted')
  })

  it('rejects unknown statuses', () => {
    expect(() => createEmailSendLogEntry(db, makeInput({ status: 'weird' as never })))
      .toThrow()
  })

  it('updates status and decision metadata', () => {
    const entry = createEmailSendLogEntry(db, makeInput({ status: 'pending' }))
    const updated = updateEmailSendLogEntry(db, entry.id, {
      status: 'approved',
      decidedBy: 'alice',
      decidedAt: '2026-04-01T10:00:00.000Z',
    })

    expect(updated?.status).toBe('approved')
    expect(updated?.decidedBy).toBe('alice')
    expect(updated?.decidedAt).toBe('2026-04-01T10:00:00.000Z')
    expect(updated?.subject).toBe(entry.subject)
  })

  it('records failures with an error message', () => {
    const entry = createEmailSendLogEntry(db, makeInput({ status: 'pending' }))
    const updated = updateEmailSendLogEntry(db, entry.id, { status: 'failed', errorMessage: 'SMTP: connection refused' })
    expect(updated?.status).toBe('failed')
    expect(updated?.errorMessage).toBe('SMTP: connection refused')
  })

  it('returns null for unknown ids', () => {
    expect(getEmailSendLogEntry(db, 'nope')).toBeNull()
    expect(updateEmailSendLogEntry(db, 'nope', { status: 'sent' })).toBeNull()
  })

  describe('filters', () => {
    beforeEach(() => {
      createEmailSendLogEntry(db, makeInput({
        accountId: 'acc-1',
        status: 'sent',
        to: ['boss@example.com'],
        subject: 'Invoice March',
        bodyText: 'Attached is the invoice.',
      }))
      createEmailSendLogEntry(db, makeInput({
        accountId: 'acc-2',
        accountName: 'Private',
        status: 'blocked',
        to: ['stranger@evil.com'],
        subject: 'Hello there',
        bodyText: 'Nothing to see.',
        reason: 'not allowlisted',
      }))
      createEmailSendLogEntry(db, makeInput({
        accountId: 'acc-1',
        status: 'pending',
        to: ['someone@else.com'],
        cc: ['boss@example.com'],
        subject: 'Question',
        bodyText: 'Do you have time?',
      }))
    })

    it('filters by account', () => {
      expect(listEmailSendLog(db, { accountId: 'acc-1' })).toHaveLength(2)
      expect(countEmailSendLog(db, { accountId: 'acc-2' })).toBe(1)
    })

    it('filters by a single status and by a status list', () => {
      expect(listEmailSendLog(db, { status: 'blocked' }).map(e => e.subject)).toEqual(['Hello there'])
      expect(listEmailSendLog(db, { status: ['sent', 'pending'] })).toHaveLength(2)
    })

    it('filters by recipient across to/cc/bcc', () => {
      expect(listEmailSendLog(db, { recipient: 'boss@example.com' })).toHaveLength(2)
      expect(listEmailSendLog(db, { recipient: 'STRANGER@evil.com' })).toHaveLength(1)
    })

    it('filters by content in subject and body', () => {
      expect(listEmailSendLog(db, { search: 'invoice' })).toHaveLength(1)
      expect(listEmailSendLog(db, { search: 'have time' }).map(e => e.subject)).toEqual(['Question'])
    })

    it('filters by date range', () => {
      expect(listEmailSendLog(db, { dateFrom: '2000-01-01T00:00:00.000Z' })).toHaveLength(3)
      expect(listEmailSendLog(db, { dateTo: '2000-01-01T00:00:00.000Z' })).toHaveLength(0)
    })

    it('paginates newest first', () => {
      const all = listEmailSendLog(db)
      expect(all.map(e => e.subject)).toEqual(['Question', 'Hello there', 'Invoice March'])
      expect(listEmailSendLog(db, { limit: 1, offset: 1 }).map(e => e.subject)).toEqual(['Hello there'])
      expect(countEmailSendLog(db)).toBe(3)
    })
  })
})
