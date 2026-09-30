import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createEmailAccount,
  deleteEmailAccount,
  getEmailAccount,
  getEmailAccountDecrypted,
  listEmailAccounts,
  loadEmailAccounts,
  updateEmailAccount,
  DEFAULT_ATTACHMENT_DOWNLOAD_PATH,
} from './email-account-store.js'
import { isEncrypted } from './encryption.js'

describe('email-account-store', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupTmpConfig(): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-email-store-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    process.env.DATA_DIR = tmpDir
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Work',
      imapHost: 'localhost',
      imapPort: 1143,
      imapUser: 'user@example.com',
      imapPassword: 'imap-secret',
      smtpHost: 'localhost',
      smtpPort: 1025,
      smtpUser: 'user@example.com',
      smtpPassword: 'smtp-secret',
      ...overrides,
    }
  }

  it('returns an empty list when no config file exists', () => {
    setupTmpConfig()
    expect(listEmailAccounts()).toEqual([])
  })

  it('creates an account with safe defaults', () => {
    setupTmpConfig()
    const account = createEmailAccount(baseInput())

    expect(account.canDelete).toBe(false)
    expect(account.allowSelfSignedCert).toBe(false)
    expect(account.appendToSentFolder).toBe(false)
    expect(account.allowHtml).toBe(false)
    expect(account.canSend).toBe(false)
    expect(account.canManage).toBe(false)
    expect(account.canDownloadAttachments).toBe(false)
    expect(account.requireApproval).toBe(false)
    expect(account.attachmentDownloadPath).toBe(DEFAULT_ATTACHMENT_DOWNLOAD_PATH)
    expect(account.allowlist).toEqual({ addresses: [], domains: [] })
  })

  it('persists accounts across loads', () => {
    setupTmpConfig()
    const created = createEmailAccount(baseInput({ displayName: 'Agent', signature: '-- AI' }))

    const listed = listEmailAccounts()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)
    expect(listed[0]?.displayName).toBe('Agent')
    expect(getEmailAccount(created.id)?.signature).toBe('-- AI')
  })

  it('stores passwords encrypted at rest and never exposes them in safe accounts', () => {
    setupTmpConfig()
    const created = createEmailAccount(baseInput())

    const raw = loadEmailAccounts().accounts[0]!
    expect(raw.imapPassword).not.toBe('imap-secret')
    expect(raw.smtpPassword).not.toBe('smtp-secret')
    expect(isEncrypted(raw.imapPassword)).toBe(true)
    expect(isEncrypted(raw.smtpPassword)).toBe(true)

    const fileContent = fs.readFileSync(path.join(tmpDir, 'config', 'email-accounts.json'), 'utf-8')
    expect(fileContent).not.toContain('imap-secret')
    expect(fileContent).not.toContain('smtp-secret')

    const safe = getEmailAccount(created.id)!
    expect(safe).not.toHaveProperty('imapPassword')
    expect(safe).not.toHaveProperty('smtpPassword')
    expect(safe.imapPasswordSet).toBe(true)
    expect(safe.smtpPasswordSet).toBe(true)

    const decrypted = getEmailAccountDecrypted(created.id)!
    expect(decrypted.imapPassword).toBe('imap-secret')
    expect(decrypted.smtpPassword).toBe('smtp-secret')
  })

  it('normalizes the allowlist', () => {
    setupTmpConfig()
    const account = createEmailAccount(baseInput({
      allowlist: {
        addresses: [' Boss@Example.com ', 'boss@example.com', ''],
        domains: ['@Example.COM', 'example.com'],
      },
    }))

    expect(account.allowlist).toEqual({
      addresses: ['boss@example.com'],
      domains: ['example.com'],
    })
  })

  it('rejects duplicate account names', () => {
    setupTmpConfig()
    createEmailAccount(baseInput())
    expect(() => createEmailAccount(baseInput())).toThrow(/already exists/)
  })

  it('updates fields and keeps the stored password when none is provided', () => {
    setupTmpConfig()
    const created = createEmailAccount(baseInput())
    const before = loadEmailAccounts().accounts[0]!.imapPassword

    const updated = updateEmailAccount(created.id, {
      name: 'Private',
      canSend: true,
      canDelete: true,
      allowHtml: true,
      attachmentDownloadPath: '  ',
    })

    expect(updated.name).toBe('Private')
    expect(updated.canSend).toBe(true)
    expect(updated.canDelete).toBe(true)
    expect(updated.allowHtml).toBe(true)
    expect(updated.attachmentDownloadPath).toBe(DEFAULT_ATTACHMENT_DOWNLOAD_PATH)
    expect(loadEmailAccounts().accounts[0]!.imapPassword).toBe(before)
    expect(getEmailAccountDecrypted(created.id)!.imapPassword).toBe('imap-secret')
  })

  it('re-encrypts a replaced password', () => {
    setupTmpConfig()
    const created = createEmailAccount(baseInput())
    updateEmailAccount(created.id, { smtpPassword: 'new-secret' })

    const raw = loadEmailAccounts().accounts[0]!
    expect(isEncrypted(raw.smtpPassword)).toBe(true)
    expect(getEmailAccountDecrypted(created.id)!.smtpPassword).toBe('new-secret')
  })

  it('throws when updating an unknown account', () => {
    setupTmpConfig()
    expect(() => updateEmailAccount('missing', { name: 'x' })).toThrow(/not found/)
  })

  it('deletes accounts', () => {
    setupTmpConfig()
    const created = createEmailAccount(baseInput())

    expect(deleteEmailAccount(created.id)).toBe(true)
    expect(listEmailAccounts()).toEqual([])
    expect(deleteEmailAccount(created.id)).toBe(false)
  })
})
