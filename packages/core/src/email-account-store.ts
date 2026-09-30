import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getConfigDir } from './config.js'
import { encrypt, decrypt, isEncrypted } from './encryption.js'
import type { EmailSecurity } from './email-client.js'

export const DEFAULT_ATTACHMENT_DOWNLOAD_PATH = 'email-attachments'

export interface EmailAllowlist {
  addresses: string[]
  domains: string[]
}

export type EmailFolderMode = 'all' | 'selected'

/**
 * One configured IMAP/SMTP account as stored in `email-accounts.json`.
 * `imapPassword` / `smtpPassword` are encrypted at rest.
 */
export interface EmailAccount {
  id: string
  name: string

  imapHost: string
  imapPort: number
  imapUser: string
  imapPassword: string
  imapSecurity: EmailSecurity

  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword: string
  smtpSecurity: EmailSecurity

  allowSelfSignedCert: boolean

  canSend: boolean
  canManage: boolean
  canDelete: boolean
  canDownloadAttachments: boolean
  requireApproval: boolean

  allowlist: EmailAllowlist

  folderMode: EmailFolderMode
  allowedFolders: string[]

  displayName: string
  signature: string

  appendToSentFolder: boolean
  allowHtml: boolean
  attachmentDownloadPath: string

  createdAt: string
  updatedAt: string
}

export interface EmailAccountsFile {
  accounts: EmailAccount[]
}

/** Account shape handed to clients — never contains passwords. */
export type SafeEmailAccount = Omit<EmailAccount, 'imapPassword' | 'smtpPassword'> & {
  imapPasswordSet: boolean
  smtpPasswordSet: boolean
}

export interface CreateEmailAccountInput {
  name: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapPassword?: string
  imapSecurity?: EmailSecurity
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword?: string
  smtpSecurity?: EmailSecurity
  allowSelfSignedCert?: boolean
  canSend?: boolean
  canManage?: boolean
  canDelete?: boolean
  canDownloadAttachments?: boolean
  requireApproval?: boolean
  allowlist?: Partial<EmailAllowlist>
  folderMode?: EmailFolderMode
  allowedFolders?: string[]
  displayName?: string
  signature?: string
  appendToSentFolder?: boolean
  allowHtml?: boolean
  attachmentDownloadPath?: string
}

export type UpdateEmailAccountInput = Partial<CreateEmailAccountInput>

function accountsFilePath(): string {
  return path.join(getConfigDir(), 'email-accounts.json')
}

function normalizeAllowlist(value: Partial<EmailAllowlist> | undefined): EmailAllowlist {
  const addresses = (value?.addresses ?? [])
    .map(entry => String(entry).trim().toLowerCase())
    .filter(Boolean)
  const domains = (value?.domains ?? [])
    .map(entry => String(entry).trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)

  return {
    addresses: [...new Set(addresses)],
    domains: [...new Set(domains)],
  }
}

/** Legacy accounts predate the explicit security field — infer it from the port. */
function normalizeSecurity(value: unknown, port: number, sslPort: number): EmailSecurity {
  if (value === 'ssl' || value === 'starttls' || value === 'none') return value
  return port === sslPort ? 'ssl' : 'starttls'
}

function normalizeFolders(value: string[] | undefined): string[] {
  const folders = (value ?? []).map(entry => String(entry).trim()).filter(Boolean)
  return [...new Set(folders)]
}

function encryptPassword(value: string | undefined): string {
  if (!value) return ''
  return isEncrypted(value) ? value : encrypt(value)
}

function decryptPassword(value: string, context: string): string {
  if (!value) return ''
  if (!isEncrypted(value)) return value
  try {
    return decrypt(value)
  } catch (err) {
    // Returning an empty password here would surface as "authentication
    // failed" and send operators chasing the wrong problem — a broken
    // ENCRYPTION_KEY or a corrupted store must name itself.
    throw new Error(`Failed to decrypt ${context}: ${(err as Error).message}`)
  }
}

export function loadEmailAccounts(): EmailAccountsFile {
  const filePath = accountsFilePath()
  if (!fs.existsSync(filePath)) {
    return { accounts: [] }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content) as Partial<EmailAccountsFile>
  const accounts = Array.isArray(data.accounts) ? data.accounts : []

  return {
    accounts: accounts.map(account => ({
      ...account,
      folderMode: account.folderMode === 'selected' ? 'selected' : 'all',
      allowedFolders: normalizeFolders(account.allowedFolders),
      imapSecurity: normalizeSecurity(account.imapSecurity, account.imapPort!, 993),
      smtpSecurity: normalizeSecurity(account.smtpSecurity, account.smtpPort!, 465),
    })),
  }
}

export function saveEmailAccounts(data: EmailAccountsFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  fs.writeFileSync(accountsFilePath(), JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export function toSafeEmailAccount(account: EmailAccount): SafeEmailAccount {
  const { imapPassword, smtpPassword, ...rest } = account
  return {
    ...rest,
    imapPasswordSet: Boolean(imapPassword),
    smtpPasswordSet: Boolean(smtpPassword),
  }
}

export function listEmailAccounts(): SafeEmailAccount[] {
  return loadEmailAccounts().accounts.map(toSafeEmailAccount)
}

export function getEmailAccount(id: string): SafeEmailAccount | null {
  const account = loadEmailAccounts().accounts.find(entry => entry.id === id)
  return account ? toSafeEmailAccount(account) : null
}

/** Account including plaintext passwords — server-side use only (IMAP/SMTP). */
export function getEmailAccountDecrypted(id: string): EmailAccount | null {
  const account = loadEmailAccounts().accounts.find(entry => entry.id === id)
  if (!account) return null

  return {
    ...account,
    imapPassword: decryptPassword(account.imapPassword, `IMAP password for account "${account.name}"`),
    smtpPassword: decryptPassword(account.smtpPassword, `SMTP password for account "${account.name}"`),
  }
}

export function createEmailAccount(input: CreateEmailAccountInput): SafeEmailAccount {
  const file = loadEmailAccounts()

  const name = input.name.trim()
  if (!name) throw new Error('Account name is required')
  if (file.accounts.some(entry => entry.name === name)) {
    throw new Error(`Email account with name "${name}" already exists`)
  }

  const now = new Date().toISOString()
  const account: EmailAccount = {
    id: crypto.randomUUID(),
    name,
    imapHost: input.imapHost.trim(),
    imapPort: input.imapPort,
    imapUser: input.imapUser.trim(),
    imapPassword: encryptPassword(input.imapPassword),
    imapSecurity: normalizeSecurity(input.imapSecurity, input.imapPort, 993),
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort,
    smtpUser: input.smtpUser.trim(),
    smtpPassword: encryptPassword(input.smtpPassword),
    smtpSecurity: normalizeSecurity(input.smtpSecurity, input.smtpPort, 465),
    allowSelfSignedCert: input.allowSelfSignedCert ?? false,
    canSend: input.canSend ?? false,
    canManage: input.canManage ?? false,
    canDelete: input.canDelete ?? false,
    canDownloadAttachments: input.canDownloadAttachments ?? false,
    requireApproval: input.requireApproval ?? false,
    allowlist: normalizeAllowlist(input.allowlist),
    folderMode: input.folderMode === 'selected' ? 'selected' : 'all',
    allowedFolders: normalizeFolders(input.allowedFolders),
    displayName: input.displayName?.trim() ?? '',
    signature: input.signature ?? '',
    appendToSentFolder: input.appendToSentFolder ?? false,
    allowHtml: input.allowHtml ?? false,
    attachmentDownloadPath: input.attachmentDownloadPath?.trim() || DEFAULT_ATTACHMENT_DOWNLOAD_PATH,
    createdAt: now,
    updatedAt: now,
  }

  file.accounts.push(account)
  saveEmailAccounts(file)
  return toSafeEmailAccount(account)
}

export function updateEmailAccount(id: string, input: UpdateEmailAccountInput): SafeEmailAccount {
  const file = loadEmailAccounts()
  const account = file.accounts.find(entry => entry.id === id)
  if (!account) {
    throw new Error(`Email account not found: ${id}`)
  }

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('Account name is required')
    if (file.accounts.some(entry => entry.id !== id && entry.name === name)) {
      throw new Error(`Email account with name "${name}" already exists`)
    }
    account.name = name
  }

  if (input.imapHost !== undefined) account.imapHost = input.imapHost.trim()
  if (input.imapPort !== undefined) account.imapPort = input.imapPort
  if (input.imapUser !== undefined) account.imapUser = input.imapUser.trim()
  if (input.imapPassword) account.imapPassword = encryptPassword(input.imapPassword)
  if (input.imapSecurity !== undefined) account.imapSecurity = input.imapSecurity

  if (input.smtpHost !== undefined) account.smtpHost = input.smtpHost.trim()
  if (input.smtpPort !== undefined) account.smtpPort = input.smtpPort
  if (input.smtpUser !== undefined) account.smtpUser = input.smtpUser.trim()
  if (input.smtpPassword) account.smtpPassword = encryptPassword(input.smtpPassword)
  if (input.smtpSecurity !== undefined) account.smtpSecurity = input.smtpSecurity

  if (input.allowSelfSignedCert !== undefined) account.allowSelfSignedCert = input.allowSelfSignedCert
  if (input.canSend !== undefined) account.canSend = input.canSend
  if (input.canManage !== undefined) account.canManage = input.canManage
  if (input.canDelete !== undefined) account.canDelete = input.canDelete
  if (input.canDownloadAttachments !== undefined) account.canDownloadAttachments = input.canDownloadAttachments
  if (input.requireApproval !== undefined) account.requireApproval = input.requireApproval
  if (input.allowlist !== undefined) account.allowlist = normalizeAllowlist(input.allowlist)
  if (input.folderMode !== undefined) account.folderMode = input.folderMode === 'selected' ? 'selected' : 'all'
  if (input.allowedFolders !== undefined) account.allowedFolders = normalizeFolders(input.allowedFolders)
  if (input.displayName !== undefined) account.displayName = input.displayName.trim()
  if (input.signature !== undefined) account.signature = input.signature
  if (input.appendToSentFolder !== undefined) account.appendToSentFolder = input.appendToSentFolder
  if (input.allowHtml !== undefined) account.allowHtml = input.allowHtml
  if (input.attachmentDownloadPath !== undefined) {
    account.attachmentDownloadPath = input.attachmentDownloadPath.trim() || DEFAULT_ATTACHMENT_DOWNLOAD_PATH
  }

  account.updatedAt = new Date().toISOString()
  saveEmailAccounts(file)
  return toSafeEmailAccount(account)
}

export function deleteEmailAccount(id: string): boolean {
  const file = loadEmailAccounts()
  const index = file.accounts.findIndex(entry => entry.id === id)
  if (index === -1) return false

  file.accounts.splice(index, 1)
  saveEmailAccounts(file)
  return true
}
