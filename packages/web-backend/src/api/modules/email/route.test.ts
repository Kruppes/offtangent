import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { CreateEmailSendLogInput, Database, EmailSendLogEntry, SafeEmailAccount } from '@axiom/core'
import { createEmailSendLogEntry, initDatabase, isEncrypted } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-email-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  server = http.createServer(createApp({ db }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`
  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function accountsFile(): string {
  return path.join(tempDataDir, 'config', 'email-accounts.json')
}

beforeEach(() => {
  fs.rmSync(accountsFile(), { force: true })
  db.prepare('DELETE FROM email_send_log').run()
})

function seedLogEntry(overrides: Partial<CreateEmailSendLogInput> = {}): EmailSendLogEntry {
  return createEmailSendLogEntry(db, {
    accountId: 'acc-1',
    accountName: 'Work',
    status: 'sent',
    to: ['boss@example.com'],
    subject: 'Status report',
    bodyText: 'All systems nominal.',
    ...overrides,
  })
}

async function fetchSendLog(query = '', token = adminToken) {
  const res = await fetch(`${baseUrl}/api/email/sent-log${query}`, { headers: authHeaders(token) })
  const body = await res.json() as { entries: EmailSendLogEntry[]; total: number; limit: number; offset: number }
  return { res, body }
}

function authHeaders(token = adminToken) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function accountPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Work',
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapUser: 'agent@example.com',
    imapPassword: 'imap-secret',
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    smtpUser: 'agent@example.com',
    smtpPassword: 'smtp-secret',
    ...overrides,
  }
}

async function createAccount(overrides: Record<string, unknown> = {}): Promise<SafeEmailAccount> {
  const res = await fetch(`${baseUrl}/api/email/accounts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(accountPayload(overrides)),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { account: SafeEmailAccount }
  return body.account
}

describe('email route module', () => {
  it('creates an account with correct defaults and without leaking passwords', async () => {
    const account = await createAccount()

    expect(account.id).toBeTruthy()
    expect(account.canDelete).toBe(false)
    expect(account.allowSelfSignedCert).toBe(false)
    expect(account.appendToSentFolder).toBe(false)
    expect(account.allowHtml).toBe(false)
    expect(account.requireApproval).toBe(false)
    expect(account.attachmentDownloadPath).toBe('email-attachments')
    expect(account).not.toHaveProperty('imapPassword')
    expect(account).not.toHaveProperty('smtpPassword')
    expect(account.imapPasswordSet).toBe(true)
    expect(account.smtpPasswordSet).toBe(true)
  })

  it('stores passwords encrypted at rest', async () => {
    await createAccount()

    const raw = fs.readFileSync(accountsFile(), 'utf-8')
    expect(raw).not.toContain('imap-secret')
    expect(raw).not.toContain('smtp-secret')

    const stored = JSON.parse(raw) as { accounts: { imapPassword: string; smtpPassword: string }[] }
    expect(isEncrypted(stored.accounts[0]!.imapPassword)).toBe(true)
    expect(isEncrypted(stored.accounts[0]!.smtpPassword)).toBe(true)
  })

  it('lists accounts without passwords', async () => {
    await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts`, { headers: authHeaders() })
    const body = await res.json() as { accounts: SafeEmailAccount[] }

    expect(res.status).toBe(200)
    expect(body.accounts).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('imap-secret')
  })

  it('gets a single account and returns 404 for unknown ids', async () => {
    const created = await createAccount()

    const found = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, { headers: authHeaders() })
    expect(found.status).toBe(200)

    const missing = await fetch(`${baseUrl}/api/email/accounts/does-not-exist`, { headers: authHeaders() })
    expect(missing.status).toBe(404)
  })

  it('updates account fields, flags and allowlist', async () => {
    const created = await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Private',
        canSend: true,
        requireApproval: true,
        allowHtml: true,
        allowlist: { addresses: ['Boss@Example.com'], domains: ['@example.org'] },
        signature: 'Sent by an AI agent',
      }),
    })

    const body = await res.json() as { account: SafeEmailAccount }
    expect(res.status).toBe(200)
    expect(body.account.name).toBe('Private')
    expect(body.account.canSend).toBe(true)
    expect(body.account.requireApproval).toBe(true)
    expect(body.account.allowHtml).toBe(true)
    expect(body.account.allowlist).toEqual({ addresses: ['boss@example.com'], domains: ['example.org'] })
    expect(body.account.signature).toBe('Sent by an AI agent')
  })

  it('persists the folder restriction', async () => {
    const created = await createAccount({ folderMode: 'selected', allowedFolders: ['INBOX', 'Archive', 'INBOX'] })
    expect(created.folderMode).toBe('selected')
    expect(created.allowedFolders).toEqual(['INBOX', 'Archive'])

    const res = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ folderMode: 'all', allowedFolders: [] }),
    })
    const body = await res.json() as { account: SafeEmailAccount }
    expect(body.account.folderMode).toBe('all')
    expect(body.account.allowedFolders).toEqual([])

    const invalid = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ folderMode: 'some' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('reports readable errors when the connection test fails', async () => {
    const res = await fetch(`${baseUrl}/api/email/accounts/test-connection`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        imapHost: '127.0.0.1',
        imapPort: 1,
        imapUser: 'agent@example.com',
        imapPassword: 'x',
        smtpHost: '127.0.0.1',
        smtpPort: 1,
        smtpUser: 'agent@example.com',
        smtpPassword: 'x',
      }),
    })

    const body = await res.json() as { ok: boolean; imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.imap.ok).toBe(false)
    expect(body.imap.error).toContain('IMAP')
    expect(body.smtp.ok).toBe(false)
    expect(body.smtp.error).toContain('SMTP')
  })

  it('rejects a connection test without IMAP host or user', async () => {
    const res = await fetch(`${baseUrl}/api/email/accounts/test-connection`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ smtpHost: '127.0.0.1' }),
    })
    expect(res.status).toBe(400)
  })

  it('reports a readable error when live folder listing fails', async () => {
    const res = await fetch(`${baseUrl}/api/email/accounts/folders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        imapHost: '127.0.0.1',
        imapPort: 1,
        imapUser: 'agent@example.com',
        imapPassword: 'x',
      }),
    })

    const body = await res.json() as { error: string }
    expect(res.status).toBe(500)
    expect(body.error).toContain('IMAP')
  })

  it('deletes an account', async () => {
    const created = await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(200)

    const list = await fetch(`${baseUrl}/api/email/accounts`, { headers: authHeaders() })
    expect((await list.json() as { accounts: unknown[] }).accounts).toHaveLength(0)
  })

  it('rejects invalid payloads', async () => {
    const missingName = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload({ name: '  ' })),
    })
    expect(missingName.status).toBe(400)

    const badPort = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload({ imapPort: 0 })),
    })
    expect(badPort.status).toBe(400)

    const badFlag = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload({ canDelete: 'yes' })),
    })
    expect(badFlag.status).toBe(400)
  })

  it('rejects duplicate account names with 409', async () => {
    await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload()),
    })
    expect(res.status).toBe(409)
  })

  it('denies non-admin users on every account endpoint', async () => {
    const created = await createAccount()

    const requests = [
      fetch(`${baseUrl}/api/email/accounts`, { headers: authHeaders(userToken) }),
      fetch(`${baseUrl}/api/email/accounts/${created.id}`, { headers: authHeaders(userToken) }),
      fetch(`${baseUrl}/api/email/accounts`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify(accountPayload({ name: 'Other' })),
      }),
      fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
        method: 'PUT',
        headers: authHeaders(userToken),
        body: JSON.stringify({ canSend: true }),
      }),
      fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(userToken),
      }),
      fetch(`${baseUrl}/api/email/accounts/test-connection`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify({ accountId: created.id }),
      }),
      fetch(`${baseUrl}/api/email/accounts/folders`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify({ accountId: created.id }),
      }),
    ]

    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(403)
    }
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/email/accounts`)
    expect(res.status).toBe(401)
  })
})

describe('email send log endpoints', () => {
  it('lists all statuses with total and paging info', async () => {
    for (const status of ['sent', 'pending', 'approved', 'rejected', 'blocked', 'failed'] as const) {
      seedLogEntry({ status, subject: `Subject ${status}` })
    }

    const { res, body } = await fetchSendLog()
    expect(res.status).toBe(200)
    expect(body.total).toBe(6)
    expect(body.entries).toHaveLength(6)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    expect([...body.entries].map(e => e.status).sort()).toEqual(
      ['approved', 'blocked', 'failed', 'pending', 'rejected', 'sent'],
    )
  })

  it('filters by account', async () => {
    seedLogEntry({ accountId: 'acc-1', accountName: 'Work' })
    seedLogEntry({ accountId: 'acc-2', accountName: 'Private' })

    const { body } = await fetchSendLog('?accountId=acc-2')
    expect(body.total).toBe(1)
    expect(body.entries[0]!.accountName).toBe('Private')
  })

  it('filters by single and multiple statuses', async () => {
    seedLogEntry({ status: 'sent' })
    seedLogEntry({ status: 'blocked' })
    seedLogEntry({ status: 'failed' })

    const single = await fetchSendLog('?status=blocked')
    expect(single.body.total).toBe(1)
    expect(single.body.entries[0]!.status).toBe('blocked')

    const multi = await fetchSendLog('?status=blocked,failed')
    expect(multi.body.total).toBe(2)

    const repeated = await fetchSendLog('?status=blocked&status=sent')
    expect(repeated.body.total).toBe(2)
  })

  it('rejects an unknown status filter', async () => {
    const res = await fetch(`${baseUrl}/api/email/sent-log?status=exploded`, { headers: authHeaders() })
    expect(res.status).toBe(400)
  })

  it('filters by recipient across to, cc and bcc', async () => {
    seedLogEntry({ to: ['boss@example.com'] })
    seedLogEntry({ to: ['other@example.com'], cc: ['Watcher@Example.org'] })
    seedLogEntry({ to: ['other@example.com'], bcc: ['hidden@example.net'] })

    expect((await fetchSendLog('?recipient=boss@example.com')).body.total).toBe(1)
    expect((await fetchSendLog('?recipient=watcher@example.org')).body.total).toBe(1)
    expect((await fetchSendLog('?recipient=hidden')).body.total).toBe(1)
    expect((await fetchSendLog('?recipient=example.com')).body.total).toBe(3)
  })

  it('filters by content across subject and body', async () => {
    seedLogEntry({ subject: 'Quarterly numbers', bodyText: 'nothing here' })
    seedLogEntry({ subject: 'Lunch', bodyText: 'Quarterly review follow-up' })
    seedLogEntry({ subject: 'Other', bodyText: 'unrelated' })

    const { body } = await fetchSendLog('?search=quarterly')
    expect(body.total).toBe(2)
  })

  it('filters by date range including date-only bounds', async () => {
    seedLogEntry({ subject: 'Today' })
    const today = new Date().toISOString().slice(0, 10)

    expect((await fetchSendLog(`?dateFrom=${today}&dateTo=${today}`)).body.total).toBe(1)
    expect((await fetchSendLog('?dateFrom=2999-01-01')).body.total).toBe(0)
    expect((await fetchSendLog('?dateTo=2000-01-01')).body.total).toBe(0)

    const invalid = await fetch(`${baseUrl}/api/email/sent-log?dateFrom=not-a-date`, { headers: authHeaders() })
    expect(invalid.status).toBe(400)
  })

  it('supports limit and offset', async () => {
    seedLogEntry({ subject: 'One' })
    seedLogEntry({ subject: 'Two' })
    seedLogEntry({ subject: 'Three' })

    const { body } = await fetchSendLog('?limit=2&offset=1')
    expect(body.total).toBe(3)
    expect(body.entries).toHaveLength(2)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(1)

    const invalid = await fetch(`${baseUrl}/api/email/sent-log?limit=-5`, { headers: authHeaders() })
    expect(invalid.status).toBe(400)
  })

  it('returns full detail including body, attachments and error message', async () => {
    const created = seedLogEntry({
      status: 'failed',
      to: ['boss@example.com'],
      cc: ['team@example.com'],
      bcc: ['archive@example.com'],
      subject: 'Report',
      bodyText: 'Full plain text body',
      bodyHtml: '<p>Full html body</p>',
      attachments: [{ filename: 'report.pdf', size: 2048, contentType: 'application/pdf' }],
      errorMessage: 'SMTP connection refused',
      reason: 'send failed',
    })

    const res = await fetch(`${baseUrl}/api/email/sent-log/${created.id}`, { headers: authHeaders() })
    const body = await res.json() as { entry: EmailSendLogEntry }

    expect(res.status).toBe(200)
    expect(body.entry.bodyText).toBe('Full plain text body')
    expect(body.entry.bodyHtml).toBe('<p>Full html body</p>')
    expect(body.entry.cc).toEqual(['team@example.com'])
    expect(body.entry.bcc).toEqual(['archive@example.com'])
    expect(body.entry.attachments).toEqual([
      { filename: 'report.pdf', size: 2048, contentType: 'application/pdf' },
    ])
    expect(body.entry.errorMessage).toBe('SMTP connection refused')
  })

  it('returns 404 for an unknown send log entry', async () => {
    const res = await fetch(`${baseUrl}/api/email/sent-log/does-not-exist`, { headers: authHeaders() })
    expect(res.status).toBe(404)
  })

  it('allows non-admin users to read the send log', async () => {
    const created = seedLogEntry()

    const list = await fetchSendLog('', userToken)
    expect(list.res.status).toBe(200)
    expect(list.body.total).toBe(1)

    const detail = await fetch(`${baseUrl}/api/email/sent-log/${created.id}`, { headers: authHeaders(userToken) })
    expect(detail.status).toBe(200)
  })

  it('requires authentication for the send log', async () => {
    expect((await fetch(`${baseUrl}/api/email/sent-log`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/email/sent-log/x`)).status).toBe(401)
  })
})

describe('email approval endpoints', () => {
  async function decide(id: string, action: 'approve' | 'reject' | 'retry', token = userToken) {
    const res = await fetch(`${baseUrl}/api/email/sent-log/${id}/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
    })
    const body = await res.json() as { entry: EmailSendLogEntry | null; error?: string; code?: string }
    return { res, body }
  }

  it('lets a non-admin user reject a pending mail and records the decider', async () => {
    const entry = seedLogEntry({ status: 'pending' })

    const { res, body } = await decide(entry.id, 'reject')

    expect(res.status).toBe(200)
    expect(body.entry!.status).toBe('rejected')
    expect(body.entry!.decidedBy).toBe('user')
    expect(body.entry!.decidedAt).toBeTruthy()
  })

  it('lets only the first decision win', async () => {
    const entry = seedLogEntry({ status: 'pending' })

    expect((await decide(entry.id, 'reject')).res.status).toBe(200)

    const second = await decide(entry.id, 'approve', adminToken)
    expect(second.res.status).toBe(409)
    expect(second.body.code).toBe('already_decided')
    expect(second.body.error).toContain('user')
    expect(second.body.entry!.decidedBy).toBe('user')
  })

  it('marks the entry failed when SMTP is unreachable and allows a retry', async () => {
    const account = await createAccount({ smtpHost: '127.0.0.1', smtpPort: 1 })
    const entry = seedLogEntry({ status: 'pending', accountId: account.id, accountName: account.name })

    const approved = await decide(entry.id, 'approve')
    expect(approved.res.status).toBe(502)
    expect(approved.body.code).toBe('send_failed')
    expect(approved.body.entry!.status).toBe('failed')
    expect(approved.body.entry!.errorMessage).toBeTruthy()
    expect(approved.body.entry!.decidedBy).toBe('user')

    const retried = await decide(entry.id, 'retry', adminToken)
    expect(retried.res.status).toBe(502)
    expect(retried.body.entry!.status).toBe('failed')
    expect(retried.body.entry!.decidedBy).toBe('admin')
  })

  it('refuses to retry an entry that did not fail', async () => {
    const entry = seedLogEntry({ status: 'sent' })

    const { res, body } = await decide(entry.id, 'retry')
    expect(res.status).toBe(409)
    expect(body.code).toBe('not_retryable')
  })

  it('returns 404 for unknown entries and 401 without a token', async () => {
    expect((await decide('does-not-exist', 'approve')).res.status).toBe(404)

    const anonymous = await fetch(`${baseUrl}/api/email/sent-log/x/approve`, { method: 'POST' })
    expect(anonymous.status).toBe(401)
  })
})
