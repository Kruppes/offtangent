import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { EmailAccount } from './email-account-store.js'
import type { EmailClient, EmailMessage, EmailMessageSummary } from './email-client.js'
import type { CreateEmailSendLogInput, EmailSendLogEntry } from './email-send-log.js'
import {
  createEmailDeleteTool,
  createEmailDownloadAttachmentTool,
  createEmailFoldersTool,
  createEmailListTool,
  createEmailMarkReadTool,
  createEmailMarkUnreadTool,
  createEmailMoveTool,
  createEmailReadTool,
  createEmailSendTool,
  createEmailTools,
  isFolderAllowed,
  safeAttachmentFilename,
} from './email-tools.js'

function makeAccount(overrides: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: 'acc-1',
    name: 'Work',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'agent@example.com',
    imapPassword: 'secret',
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpUser: 'agent@example.com',
    smtpPassword: 'secret',
    imapSecurity: 'ssl',
    smtpSecurity: 'ssl',
    allowSelfSignedCert: false,
    canSend: false,
    canManage: false,
    canDelete: false,
    canDownloadAttachments: false,
    requireApproval: false,
    allowlist: { addresses: [], domains: [] },
    folderMode: 'all',
    allowedFolders: [],
    displayName: 'Agent',
    signature: '',
    appendToSentFolder: false,
    allowHtml: false,
    attachmentDownloadPath: 'email-attachments',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSummary(overrides: Partial<EmailMessageSummary> = {}): EmailMessageSummary {
  return {
    uid: 42,
    folder: 'INBOX',
    subject: 'Invoice March',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ address: 'agent@example.com' }],
    date: '2026-03-01T10:00:00.000Z',
    seen: false,
    flagged: false,
    size: 1234,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    ...makeSummary(),
    cc: [],
    references: [],
    text: 'Hello from the invoice',
    attachments: [],
    ...overrides,
  }
}

function mockClient(overrides: Partial<EmailClient> = {}): EmailClient {
  return {
    testConnection: vi.fn(),
    listFolders: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    readMessage: vi.fn().mockResolvedValue(makeMessage()),
    setSeen: vi.fn(),
    moveMessages: vi.fn(),
    deleteMessages: vi.fn(),
    downloadAttachment: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
  } as unknown as EmailClient
}

function makeDeps(accounts: EmailAccount[], client: EmailClient, workspaceDir?: string) {
  return {
    client,
    listAccounts: () => accounts.map(a => ({ id: a.id, name: a.name })),
    getAccount: (id: string) => accounts.find(a => a.id === id) ?? null,
    ...(workspaceDir ? { workspaceDir: () => workspaceDir } : {}),
  }
}

function text(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(item => item.type === 'text').map(item => item.text ?? '').join('')
}

function details(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('isFolderAllowed', () => {
  it('allows everything in "all" mode', () => {
    expect(isFolderAllowed(makeAccount(), 'Whatever')).toBe(true)
  })

  it('restricts to the selected folders, case-insensitively', () => {
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX', 'Archive/2026'] })
    expect(isFolderAllowed(account, 'inbox')).toBe(true)
    expect(isFolderAllowed(account, 'Archive/2026')).toBe(true)
    expect(isFolderAllowed(account, 'Archive')).toBe(false)
  })
})

describe('createEmailTools', () => {
  it('registers no tools when no account exists', () => {
    expect(createEmailTools(makeDeps([], mockClient()))).toEqual([])
  })

  it('registers the read and flag tools for a readonly account', () => {
    const tools = createEmailTools(makeDeps([makeAccount()], mockClient()))
    expect(tools.map(tool => tool.name)).toEqual([
      'email_list',
      'email_folders',
      'email_read',
      'email_mark_read',
      'email_mark_unread',
    ])
  })

  it('registers management tools only when an account grants the capability', () => {
    const accounts = [
      makeAccount(),
      makeAccount({ id: 'acc-2', name: 'Private', canManage: true, canDownloadAttachments: true }),
    ]
    const tools = createEmailTools(makeDeps(accounts, mockClient())).map(tool => tool.name)

    expect(tools).toContain('email_move')
    expect(tools).toContain('email_download_attachment')
    expect(tools).not.toContain('email_delete')
  })
})

describe('email_list tool', () => {
  it('defaults to unread messages in INBOX with a limit of 50', async () => {
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([makeSummary()]) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: 'imap.example.com' }),
      { folder: 'INBOX', unseenOnly: true, limit: 50 },
    )
    expect(text(result)).toContain('UID 42')
    expect(text(result)).toContain('Invoice March')
    expect(text(result)).toContain('Alice <alice@example.com>')
    expect(details(result).count).toBe(1)
  })

  it('returns metadata only, never the message body', async () => {
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([makeSummary()]) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(text(result)).not.toContain('Hello from the invoice')
  })

  it('caps the limit and honours explicit folder / unread_only', async () => {
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([]) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    await tool.execute('call-1', { folder: 'Archive', unread_only: false, limit: 5000 })

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.anything(),
      { folder: 'Archive', unseenOnly: false, limit: 100 },
    )
  })

  it('blocks folders outside the account restriction', async () => {
    const client = mockClient()
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailListTool(makeDeps([account], client))

    const result = await tool.execute('call-1', { folder: 'Secret' })

    expect(text(result)).toContain('not accessible')
    expect(details(result).error).toBe(true)
    expect(client.listMessages).not.toHaveBeenCalled()
  })

  it('requires an account parameter when several accounts exist', async () => {
    const accounts = [makeAccount(), makeAccount({ id: 'acc-2', name: 'Private' })]
    const tool = createEmailListTool(makeDeps(accounts, mockClient()))

    const result = await tool.execute('call-1', {})

    expect(text(result)).toContain('Multiple email accounts')
    expect(text(result)).toContain('"Private" (acc-2)')
    expect(details(result).error).toBe(true)
  })

  it('selects the account by name', async () => {
    const accounts = [makeAccount(), makeAccount({ id: 'acc-2', name: 'Private', imapHost: 'imap.private.test' })]
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([]) })
    const tool = createEmailListTool(makeDeps(accounts, client))

    await tool.execute('call-1', { account: 'private' })

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: 'imap.private.test' }),
      expect.anything(),
    )
  })

  it('reports unknown accounts with the available ones', async () => {
    const tool = createEmailListTool(makeDeps([makeAccount()], mockClient()))

    const result = await tool.execute('call-1', { account: 'nope' })

    expect(text(result)).toContain('Unknown email account "nope"')
    expect(text(result)).toContain('"Work" (acc-1)')
  })

  it('surfaces client errors as tool errors', async () => {
    const client = mockClient({ listMessages: vi.fn().mockRejectedValue(new Error('IMAP: authentication failed')) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(text(result)).toContain('IMAP: authentication failed')
    expect(details(result).error).toBe(true)
  })
})

describe('email_folders tool', () => {
  const folders = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', subscribed: true },
    { path: 'Archive', name: 'Archive', delimiter: '/', subscribed: true },
  ]

  it('lists all folders when the account is unrestricted', async () => {
    const client = mockClient({ listFolders: vi.fn().mockResolvedValue(folders) })
    const tool = createEmailFoldersTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(details(result).folders).toEqual(['INBOX', 'Archive'])
  })

  it('hides folders outside the account restriction', async () => {
    const client = mockClient({ listFolders: vi.fn().mockResolvedValue(folders) })
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailFoldersTool(makeDeps([account], client))

    const result = await tool.execute('call-1', {})

    expect(details(result).folders).toEqual(['INBOX'])
    expect(text(result)).not.toContain('Archive')
  })
})

describe('email_read tool', () => {
  it('reads the message body and marks it as read', async () => {
    const message = makeMessage({ text: 'Converted body text', attachments: [] })
    const client = mockClient({ readMessage: vi.fn().mockResolvedValue(message) })
    const tool = createEmailReadTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', { uid: 42 })

    expect(client.readMessage).toHaveBeenCalledWith(
      expect.objectContaining({ imapUser: 'agent@example.com' }),
      'INBOX',
      42,
      { markSeen: true },
    )
    expect(text(result)).toContain('Subject: Invoice March')
    expect(text(result)).toContain('Converted body text')
    expect(details(result).markedRead).toBe(true)
  })

  it('marks as read even for readonly accounts', async () => {
    const client = mockClient({ readMessage: vi.fn().mockResolvedValue(makeMessage()) })
    const readonly = makeAccount({ canSend: false, canManage: false, canDelete: false })
    const tool = createEmailReadTool(makeDeps([readonly], client))

    const result = await tool.execute('call-1', { uid: 42 })

    expect(details(result).markedRead).toBe(true)
    expect(details(result).error).toBeUndefined()
  })

  it('blocks folders outside the account restriction', async () => {
    const client = mockClient()
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailReadTool(makeDeps([account], client))

    const result = await tool.execute('call-1', { uid: 1, folder: 'Secret' })

    expect(text(result)).toContain('not accessible')
    expect(client.readMessage).not.toHaveBeenCalled()
  })

  it('rejects a missing uid', async () => {
    const tool = createEmailReadTool(makeDeps([makeAccount()], mockClient()))

    const result = await tool.execute('call-1', {})

    expect(text(result)).toContain('"uid" must be a number')
  })

  it('lists attachment metadata', async () => {
    const message = makeMessage({
      attachments: [{ partId: '2', filename: 'invoice.pdf', contentType: 'application/pdf', size: 2048 }],
    })
    const client = mockClient({ readMessage: vi.fn().mockResolvedValue(message) })
    const tool = createEmailReadTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', { uid: 42 })

    expect(text(result)).toContain('invoice.pdf (application/pdf, 2048 bytes)')
  })
})

describe('email_mark_read / email_mark_unread tools', () => {
  it('marks several UIDs in a single call', async () => {
    const client = mockClient({ setSeen: vi.fn().mockResolvedValue(3) })
    const tool = createEmailMarkReadTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', { uids: [1, 2, 3] })

    expect(client.setSeen).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: 'imap.example.com' }),
      'INBOX',
      [1, 2, 3],
      true,
    )
    expect(text(result)).toContain('Marked 3 message(s) as read')
    expect(details(result).count).toBe(3)
  })

  it('deduplicates UIDs and never loads message bodies', async () => {
    const client = mockClient({ setSeen: vi.fn().mockResolvedValue(2) })
    const tool = createEmailMarkReadTool(makeDeps([makeAccount()], client))

    await tool.execute('call-1', { uids: [7, 7, 8] })

    expect(client.setSeen).toHaveBeenCalledWith(expect.anything(), 'INBOX', [7, 8], true)
    expect(client.readMessage).not.toHaveBeenCalled()
  })

  it('works for readonly accounts (no manage/delete permission)', async () => {
    const client = mockClient({ setSeen: vi.fn().mockResolvedValue(1) })
    const readonly = makeAccount({ canManage: false, canDelete: false, canDownloadAttachments: false })

    const read = await createEmailMarkReadTool(makeDeps([readonly], client)).execute('c1', { uids: [1] })
    const unread = await createEmailMarkUnreadTool(makeDeps([readonly], client)).execute('c2', { uids: [1] })

    expect(details(read).error).toBeUndefined()
    expect(details(unread).error).toBeUndefined()
    expect(client.setSeen).toHaveBeenLastCalledWith(expect.anything(), 'INBOX', [1], false)
  })

  it('rejects an empty or invalid uid list', async () => {
    const client = mockClient({ setSeen: vi.fn() })
    const tool = createEmailMarkReadTool(makeDeps([makeAccount()], client))

    expect(text(await tool.execute('c1', { uids: [] }))).toContain('"uids" must be a non-empty array')
    expect(text(await tool.execute('c2', { uids: ['nope'] }))).toContain('"uids" must be a non-empty array')
    expect(client.setSeen).not.toHaveBeenCalled()
  })

  it('blocks folders outside the account restriction', async () => {
    const client = mockClient({ setSeen: vi.fn() })
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailMarkReadTool(makeDeps([account], client))

    const result = await tool.execute('c1', { uids: [1], folder: 'Secret' })

    expect(text(result)).toContain('not accessible')
    expect(client.setSeen).not.toHaveBeenCalled()
  })
})

describe('email_move tool', () => {
  const manageAccount = makeAccount({ canManage: true })

  it('moves messages to the target folder', async () => {
    const client = mockClient({ moveMessages: vi.fn().mockResolvedValue(2) })
    const tool = createEmailMoveTool(makeDeps([manageAccount], client))

    const result = await tool.execute('c1', { uids: [4, 5], target_folder: 'Archive' })

    expect(client.moveMessages).toHaveBeenCalledWith(expect.anything(), 'INBOX', [4, 5], 'Archive')
    expect(text(result)).toContain('Moved 2 message(s) from "INBOX" to "Archive"')
  })

  it('is refused for a readonly account', async () => {
    const client = mockClient({ moveMessages: vi.fn() })
    const tool = createEmailMoveTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('c1', { uids: [1], target_folder: 'Archive' })

    expect(text(result)).toContain('not allowed to manage mailbox')
    expect(details(result).capability).toBe('canManage')
    expect(client.moveMessages).not.toHaveBeenCalled()
  })

  it('blocks target folders outside the account restriction', async () => {
    const client = mockClient({ moveMessages: vi.fn() })
    const account = makeAccount({ canManage: true, folderMode: 'selected', allowedFolders: ['INBOX', 'Archive'] })
    const tool = createEmailMoveTool(makeDeps([account], client))

    const result = await tool.execute('c1', { uids: [1], target_folder: 'Secret' })

    expect(text(result)).toContain('not accessible')
    expect(client.moveMessages).not.toHaveBeenCalled()
  })

  it('requires a target folder', async () => {
    const client = mockClient({ moveMessages: vi.fn() })
    const tool = createEmailMoveTool(makeDeps([manageAccount], client))

    expect(text(await tool.execute('c1', { uids: [1] }))).toContain('"target_folder" is required')
    expect(text(await tool.execute('c2', { uids: [1], target_folder: 'inbox' }))).toContain('identical')
    expect(client.moveMessages).not.toHaveBeenCalled()
  })
})

describe('email_delete tool', () => {
  it('deletes messages when the account may delete', async () => {
    const client = mockClient({ deleteMessages: vi.fn().mockResolvedValue(1) })
    const tool = createEmailDeleteTool(makeDeps([makeAccount({ canDelete: true })], client))

    const result = await tool.execute('c1', { uids: [9] })

    expect(client.deleteMessages).toHaveBeenCalledWith(expect.anything(), 'INBOX', [9])
    expect(text(result)).toContain('Deleted 1 message(s)')
  })

  it('is refused for a readonly account and for a manage-only account', async () => {
    const client = mockClient({ deleteMessages: vi.fn() })
    const readonly = await createEmailDeleteTool(makeDeps([makeAccount()], client)).execute('c1', { uids: [1] })
    const manageOnly = await createEmailDeleteTool(
      makeDeps([makeAccount({ canManage: true })], client),
    ).execute('c2', { uids: [1] })

    expect(text(readonly)).toContain('not allowed to delete messages')
    expect(details(manageOnly).capability).toBe('canDelete')
    expect(client.deleteMessages).not.toHaveBeenCalled()
  })
})

describe('email_download_attachment tool', () => {
  let workspace: string

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-email-attach-'))
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function attachmentClient() {
    return mockClient({
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('PDF-DATA'),
      }),
    })
  }

  it('stores the attachment under the configured workspace path', async () => {
    const client = attachmentClient()
    const account = makeAccount({ canDownloadAttachments: true, attachmentDownloadPath: 'downloads/mail' })
    const tool = createEmailDownloadAttachmentTool(makeDeps([account], client, workspace))

    const result = await tool.execute('c1', { uid: 42, part_id: '2' })

    const expected = path.join(workspace, 'downloads/mail', 'invoice.pdf')
    expect(details(result).path).toBe(expected)
    expect(fs.readFileSync(expected, 'utf-8')).toBe('PDF-DATA')
    expect(client.downloadAttachment).toHaveBeenCalledWith(expect.anything(), 'INBOX', 42, '2')
  })

  it('does not overwrite an existing file', async () => {
    const client = attachmentClient()
    const account = makeAccount({ canDownloadAttachments: true })
    const tool = createEmailDownloadAttachmentTool(makeDeps([account], client, workspace))

    await tool.execute('c1', { uid: 42, part_id: '2' })
    const second = await tool.execute('c2', { uid: 42, part_id: '2' })

    expect(details(second).path).toBe(path.join(workspace, 'email-attachments', 'invoice-1.pdf'))
  })

  it('keeps traversing filenames inside the workspace directory', async () => {
    const client = attachmentClient()
    const account = makeAccount({ canDownloadAttachments: true, attachmentDownloadPath: '../../escape' })
    const tool = createEmailDownloadAttachmentTool(makeDeps([account], client, workspace))

    const result = await tool.execute('c1', { uid: 42, part_id: '2', filename: '../../../etc/passwd' })

    expect(details(result).path).toBe(path.join(workspace, 'email-attachments', 'passwd'))
  })

  it('is refused when the account may not download attachments', async () => {
    const client = attachmentClient()
    const tool = createEmailDownloadAttachmentTool(makeDeps([makeAccount({ canManage: true })], client, workspace))

    const result = await tool.execute('c1', { uid: 42, part_id: '2' })

    expect(text(result)).toContain('not allowed to download attachments')
    expect(details(result).capability).toBe('canDownloadAttachments')
    expect(client.downloadAttachment).not.toHaveBeenCalled()
  })

  it('requires uid and part_id', async () => {
    const client = attachmentClient()
    const tool = createEmailDownloadAttachmentTool(
      makeDeps([makeAccount({ canDownloadAttachments: true })], client, workspace),
    )

    expect(text(await tool.execute('c1', { part_id: '2' }))).toContain('"uid" must be a number')
    expect(text(await tool.execute('c2', { uid: 1 }))).toContain('"part_id" is required')
  })
})

describe('capability matrix', () => {
  const cases = [
    { name: 'readonly', account: {}, allowed: ['email_mark_read', 'email_mark_unread'] },
    { name: 'manage', account: { canManage: true }, allowed: ['email_mark_read', 'email_mark_unread', 'email_move'] },
    {
      name: 'delete',
      account: { canDelete: true },
      allowed: ['email_mark_read', 'email_mark_unread', 'email_delete'],
    },
    {
      name: 'attachments',
      account: { canDownloadAttachments: true },
      allowed: ['email_mark_read', 'email_mark_unread', 'email_download_attachment'],
    },
    {
      name: 'full',
      account: { canManage: true, canDelete: true, canDownloadAttachments: true },
      allowed: ['email_mark_read', 'email_mark_unread', 'email_move', 'email_delete', 'email_download_attachment'],
    },
  ]

  const params: Record<string, Record<string, unknown>> = {
    email_mark_read: { uids: [1] },
    email_mark_unread: { uids: [1] },
    email_move: { uids: [1], target_folder: 'Archive' },
    email_delete: { uids: [1] },
    email_download_attachment: { uid: 1, part_id: '2' },
  }

  for (const testCase of cases) {
    it(`enforces the permissions of a ${testCase.name} account`, async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-email-matrix-'))
      try {
        const account = makeAccount(testCase.account)
        const client = mockClient({
          setSeen: vi.fn().mockResolvedValue(1),
          moveMessages: vi.fn().mockResolvedValue(1),
          deleteMessages: vi.fn().mockResolvedValue(1),
          downloadAttachment: vi.fn().mockResolvedValue({
            filename: 'a.txt',
            contentType: 'text/plain',
            content: Buffer.from('x'),
          }),
        })
        const deps = makeDeps([account], client, workspace)
        const tools = [
          createEmailMarkReadTool(deps),
          createEmailMarkUnreadTool(deps),
          createEmailMoveTool(deps),
          createEmailDeleteTool(deps),
          createEmailDownloadAttachmentTool(deps),
        ]

        for (const tool of tools) {
          const result = await tool.execute('c1', params[tool.name]!)
          const denied = details(result).error === true
          expect(denied, `${tool.name} for ${testCase.name}`).toBe(!testCase.allowed.includes(tool.name))
        }
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true })
      }
    })
  }
})

describe('safeAttachmentFilename', () => {
  it('strips directories and leading dots', () => {
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('passwd')
    expect(safeAttachmentFilename('C:\\temp\\report.pdf')).toBe('report.pdf')
    expect(safeAttachmentFilename('...')).toBe('attachment')
  })
})

describe('createEmailSendTool', () => {
  function sendLogSpy() {
    const entries: CreateEmailSendLogInput[] = []
    const logSend = vi.fn((input: CreateEmailSendLogInput) => {
      entries.push(input)
      return { id: `log-${entries.length}`, ...input } as unknown as EmailSendLogEntry
    })
    return { entries, logSend }
  }

  function sendDeps(account: EmailAccount, client: EmailClient, workspaceDir?: string) {
    const log = sendLogSpy()
    return { deps: { ...makeDeps([account], client, workspaceDir), logSend: log.logSend }, log }
  }

  const allowlisted = {
    canSend: true,
    allowlist: { addresses: ['boss@example.com'], domains: ['partner.org'] },
  }

  function sendResult() {
    return { messageId: '<sent@example.com>', accepted: ['boss@example.com'], rejected: [], appendedToSent: false }
  }

  it('is not registered for accounts without canSend', () => {
    const tools = createEmailTools(makeDeps([makeAccount()], mockClient()))
    expect(tools.map(tool => tool.name)).not.toContain('email_send')

    const sending = createEmailTools(makeDeps([makeAccount(allowlisted)], mockClient()))
    expect(sending.map(tool => tool.name)).toContain('email_send')
  })

  it('refuses to send for an account without the send permission', async () => {
    const client = mockClient({ sendMessage: vi.fn() })
    const { deps, log } = sendDeps(makeAccount(), client)

    const result = await createEmailSendTool(deps).execute('c1', {
      to: ['boss@example.com'],
      subject: 'Hi',
      body: 'Hello',
    })

    expect(details(result).error).toBe(true)
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(log.entries).toHaveLength(0)
  })

  it('sends to an allowlisted recipient and logs it as sent', async () => {
    const client = mockClient({ sendMessage: vi.fn().mockResolvedValue(sendResult()) })
    const { deps, log } = sendDeps(makeAccount({ ...allowlisted, signature: 'Sent by an AI agent' }), client)

    const result = await createEmailSendTool(deps).execute('c1', {
      to: ['boss@example.com'],
      subject: 'Status',
      body: 'All good.',
    })

    expect(details(result).error).toBeUndefined()
    expect(details(result).status).toBe('sent')
    const sent = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(sent.text).toBe('All good.\n\n-- \nSent by an AI agent')
    expect(sent.html).toBeUndefined()
    expect(log.entries[0]).toMatchObject({ status: 'sent', to: ['boss@example.com'], subject: 'Status' })
    expect(log.entries[0].bodyText).toContain('Sent by an AI agent')
  })

  it('expands smuggled recipients so the check, the log and SMTP agree', async () => {
    const client = mockClient({ sendMessage: vi.fn().mockResolvedValue(sendResult()) })
    const { deps, log } = sendDeps(makeAccount(allowlisted), client)

    const blocked = await createEmailSendTool(deps).execute('c1', {
      to: ['stranger@evil.com, boss@example.com'],
      subject: 'Hi',
      body: 'Hello',
    })

    expect(details(blocked).error).toBe(true)
    expect(client.sendMessage).not.toHaveBeenCalled()

    await createEmailSendTool(deps).execute('c2', {
      to: ['Boss <boss@example.com>, someone@partner.org'],
      subject: 'Hi',
      body: 'Hello',
    })

    const sent = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(sent.to).toEqual(['boss@example.com', 'someone@partner.org'])
    expect(log.entries[1]).toMatchObject({ status: 'sent', to: ['boss@example.com', 'someone@partner.org'] })
  })

  it('blocks a non-allowlisted recipient and logs the reason', async () => {
    const client = mockClient({ sendMessage: vi.fn() })
    const { deps, log } = sendDeps(makeAccount(allowlisted), client)

    const result = await createEmailSendTool(deps).execute('c1', {
      to: ['stranger@evil.com'],
      subject: 'Hi',
      body: 'Hello',
    })

    expect(details(result).error).toBe(true)
    expect(text(result)).toContain('blocked')
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(log.entries[0].status).toBe('blocked')
    expect(log.entries[0].reason).toContain('stranger@evil.com')
  })

  it('blocks when a CC recipient violates the allowlist', async () => {
    const client = mockClient({ sendMessage: vi.fn() })
    const { deps, log } = sendDeps(makeAccount(allowlisted), client)

    await createEmailSendTool(deps).execute('c1', {
      to: ['boss@example.com'],
      cc: ['stranger@evil.com'],
      subject: 'Hi',
      body: 'Hello',
    })

    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(log.entries[0].status).toBe('blocked')
  })

  it('holds a non-allowlisted recipient as pending when approval is required', async () => {
    const client = mockClient({ sendMessage: vi.fn() })
    const { deps, log } = sendDeps(makeAccount({ ...allowlisted, requireApproval: true }), client)

    const result = await createEmailSendTool(deps).execute('c1', {
      to: ['stranger@evil.com'],
      subject: 'Hi',
      body: 'Hello',
    })

    expect(details(result).error).toBeUndefined()
    expect(details(result).status).toBe('pending')
    expect(text(result)).toMatch(/approval/i)
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(log.entries[0].status).toBe('pending')
    expect(log.entries[0].bodyText).toBe('Hello')
  })

  it('logs a failed SMTP attempt', async () => {
    const client = mockClient({ sendMessage: vi.fn().mockRejectedValue(new Error('SMTP: connection refused')) })
    const { deps, log } = sendDeps(makeAccount(allowlisted), client)

    const result = await createEmailSendTool(deps).execute('c1', {
      to: ['boss@example.com'],
      subject: 'Hi',
      body: 'Hello',
    })

    expect(details(result).error).toBe(true)
    expect(log.entries[0].status).toBe('failed')
    expect(log.entries[0].errorMessage).toContain('connection refused')
  })

  it('only sends HTML when the account allows it', async () => {
    const plainClient = mockClient({ sendMessage: vi.fn().mockResolvedValue(sendResult()) })
    const plain = sendDeps(makeAccount(allowlisted), plainClient)
    await createEmailSendTool(plain.deps).execute('c1', {
      to: ['boss@example.com'],
      subject: 'Hi',
      body: 'Hello',
      html_body: '<p>Hello</p>',
    })
    expect((plainClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].html).toBeUndefined()
    expect(plain.log.entries[0].bodyHtml).toBeNull()

    const htmlClient = mockClient({ sendMessage: vi.fn().mockResolvedValue(sendResult()) })
    const html = sendDeps(makeAccount({ ...allowlisted, allowHtml: true, signature: 'Agent' }), htmlClient)
    await createEmailSendTool(html.deps).execute('c1', {
      to: ['boss@example.com'],
      subject: 'Hi',
      body: 'Hello',
      html_body: '<p>Hello</p>',
    })
    const htmlSent = (htmlClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(htmlSent.html).toContain('<p>Hello</p>')
    expect(htmlSent.html).toContain('Agent')
  })

  it('keeps the thread intact when replying', async () => {
    const original = makeMessage({
      subject: 'Invoice March',
      messageId: '<orig@example.com>',
      references: ['<root@example.com>'],
      from: [{ address: 'boss@example.com' }],
    })
    const client = mockClient({
      readMessage: vi.fn().mockResolvedValue(original),
      sendMessage: vi.fn().mockResolvedValue(sendResult()),
    })
    const { deps, log } = sendDeps(makeAccount(allowlisted), client)

    await createEmailSendTool(deps).execute('c1', { reply_to_uid: 42, body: 'Thanks!' })

    expect(client.readMessage).toHaveBeenCalledWith(expect.anything(), 'INBOX', 42, { markSeen: false })
    const sent = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(sent.to).toEqual(['boss@example.com'])
    expect(sent.subject).toBe('Re: Invoice March')
    expect(sent.inReplyTo).toBe('<orig@example.com>')
    expect(sent.references).toEqual(['<root@example.com>', '<orig@example.com>'])
    expect(log.entries[0].inReplyTo).toBe('<orig@example.com>')
  })

  it('applies the allowlist to replies as well', async () => {
    const original = makeMessage({ messageId: '<orig@example.com>', from: [{ address: 'stranger@evil.com' }] })
    const client = mockClient({
      readMessage: vi.fn().mockResolvedValue(original),
      sendMessage: vi.fn(),
    })
    const { deps, log } = sendDeps(makeAccount(allowlisted), client)

    const result = await createEmailSendTool(deps).execute('c1', { reply_to_uid: 42, body: 'Thanks!' })

    expect(details(result).error).toBe(true)
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(log.entries[0].status).toBe('blocked')
  })

  it('attaches workspace files and rejects paths outside the workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-email-send-'))
    try {
      fs.writeFileSync(path.join(workspace, 'report.pdf'), 'pdf-bytes')
      const client = mockClient({ sendMessage: vi.fn().mockResolvedValue(sendResult()) })
      const { deps, log } = sendDeps(makeAccount(allowlisted), client, workspace)

      await createEmailSendTool(deps).execute('c1', {
        to: ['boss@example.com'],
        subject: 'Hi',
        body: 'Hello',
        attachments: ['report.pdf'],
      })

      const sent = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]
      expect(sent.attachments).toEqual([{ filename: 'report.pdf', path: path.join(workspace, 'report.pdf') }])
      expect(log.entries[0].attachments).toEqual([
        { filename: 'report.pdf', path: path.join(workspace, 'report.pdf'), size: 9 },
      ])

      const escaped = await createEmailSendTool(deps).execute('c1', {
        to: ['boss@example.com'],
        subject: 'Hi',
        body: 'Hello',
        attachments: ['../outside.txt'],
      })
      expect(details(escaped).error).toBe(true)
      expect(text(escaped)).toContain('outside the workspace')

      const missing = await createEmailSendTool(deps).execute('c1', {
        to: ['boss@example.com'],
        subject: 'Hi',
        body: 'Hello',
        attachments: ['nope.txt'],
      })
      expect(text(missing)).toContain('was not found')
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('requires a subject for new messages and a non-empty body', async () => {
    const client = mockClient({ sendMessage: vi.fn() })
    const { deps } = sendDeps(makeAccount(allowlisted), client)
    const tool = createEmailSendTool(deps)

    expect(text(await tool.execute('c1', { to: ['boss@example.com'], body: 'Hello' }))).toContain('subject')
    expect(text(await tool.execute('c1', { to: ['boss@example.com'], subject: 'Hi', body: '  ' }))).toContain('body')
    expect(client.sendMessage).not.toHaveBeenCalled()
  })
})
