import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import {
  DEFAULT_ATTACHMENT_DOWNLOAD_PATH,
  getEmailAccountDecrypted,
  listEmailAccounts,
} from './email-account-store.js'
import type { EmailAccount } from './email-account-store.js'
import { createEmailClient, formatAddress, parseAddressList } from './email-client.js'
import type { EmailClient, EmailClientAccount, EmailOutgoingAttachment } from './email-client.js'
import { notifyEmailApprovalRequested } from './email-approval-notifier.js'
import { evaluateEmailSendPolicy } from './email-send-policy.js'
import { createEmailSendLogEntry } from './email-send-log.js'
import type { CreateEmailSendLogInput, EmailSendLogAttachment, EmailSendLogEntry } from './email-send-log.js'
import { getDatabase } from './database.js'
import { getWorkspaceDir } from './workspace.js'

export const DEFAULT_EMAIL_FOLDER = 'INBOX'
export const DEFAULT_EMAIL_LIST_LIMIT = 50
export const MAX_EMAIL_LIST_LIMIT = 100
export const MAX_EMAIL_BULK_UIDS = 200

/**
 * Boundary the email tools depend on. Injectable so tests can drive the tools
 * without an IMAP server and without touching the accounts file.
 */
export interface EmailToolsDeps {
  client?: EmailClient
  listAccounts?: () => { id: string; name: string }[]
  getAccount?: (id: string) => EmailAccount | null
  workspaceDir?: () => string
  logSend?: (input: CreateEmailSendLogInput) => EmailSendLogEntry
}

interface ResolvedDeps {
  client: EmailClient
  listAccounts: () => { id: string; name: string }[]
  getAccount: (id: string) => EmailAccount | null
  workspaceDir: () => string
  logSend: (input: CreateEmailSendLogInput) => EmailSendLogEntry
}

function resolveDeps(deps: EmailToolsDeps = {}): ResolvedDeps {
  return {
    client: deps.client ?? createEmailClient(),
    listAccounts: deps.listAccounts ?? (() => listEmailAccounts().map(a => ({ id: a.id, name: a.name }))),
    getAccount: deps.getAccount ?? getEmailAccountDecrypted,
    workspaceDir: deps.workspaceDir ?? getWorkspaceDir,
    logSend: deps.logSend ?? (input => createEmailSendLogEntry(getDatabase(), input)),
  }
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  details: Record<string, unknown>
}

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details }
}

function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], details: { ...details, error: true } }
}

export function toClientAccount(account: EmailAccount): EmailClientAccount {
  return {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUser: account.imapUser,
    imapPassword: account.imapPassword,
    imapSecurity: account.imapSecurity,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpUser: account.smtpUser,
    smtpPassword: account.smtpPassword,
    smtpSecurity: account.smtpSecurity,
    allowSelfSignedCert: account.allowSelfSignedCert,
    displayName: account.displayName,
    appendToSentFolder: account.appendToSentFolder,
  }
}

/** Server-side folder restriction — the agent can never reach a folder outside it. */
export function isFolderAllowed(account: EmailAccount, folder: string): boolean {
  if (account.folderMode !== 'selected') return true
  const target = folder.trim().toLowerCase()
  return account.allowedFolders.some(entry => entry.trim().toLowerCase() === target)
}

type Resolution<T> = { ok: true; value: T } | { ok: false; error: ToolResult }

function resolveAccount(deps: ResolvedDeps, requested?: string): Resolution<EmailAccount> {
  const available = deps.listAccounts()
  if (available.length === 0) {
    return { ok: false, error: fail('No email accounts are configured.') }
  }

  const known = () => available.map(entry => `"${entry.name}" (${entry.id})`).join(', ')

  let selected: { id: string; name: string } | undefined
  const wanted = requested?.trim()
  if (!wanted) {
    if (available.length > 1) {
      return {
        ok: false,
        error: fail(`Multiple email accounts are configured — pass the "account" parameter. Available: ${known()}`),
      }
    }
    selected = available[0]
  } else {
    selected =
      available.find(entry => entry.id === wanted) ??
      available.find(entry => entry.name.toLowerCase() === wanted.toLowerCase())
    if (!selected) {
      return { ok: false, error: fail(`Unknown email account "${wanted}". Available: ${known()}`) }
    }
  }

  let account: EmailAccount | null
  try {
    account = deps.getAccount(selected.id)
  } catch (err) {
    return { ok: false, error: fail(`Email account "${selected.name}" could not be loaded: ${errorText(err)}`) }
  }
  if (!account) {
    return { ok: false, error: fail(`Email account "${selected.name}" could not be loaded.`) }
  }
  return { ok: true, value: account }
}

function resolveFolder(account: EmailAccount, folder?: string): Resolution<string> {
  const target = folder?.trim() || DEFAULT_EMAIL_FOLDER
  if (!isFolderAllowed(account, target)) {
    return {
      ok: false,
      error: fail(
        `Folder "${target}" is not accessible for account "${account.name}". Allowed folders: ${account.allowedFolders.join(', ') || 'none'}`,
      ),
    }
  }
  return { ok: true, value: target }
}

function accountParam() {
  return Type.Optional(
    Type.String({
      description: 'Email account name or id. Optional when only one account is configured. Use email_folders output or the error message to discover account names.',
    }),
  )
}

function uidsParam(description: string) {
  return Type.Array(Type.Number(), { description })
}

type EmailCapability = 'canSend' | 'canManage' | 'canDelete' | 'canDownloadAttachments'

const CAPABILITY_LABEL: Record<EmailCapability, string> = {
  canSend: 'send emails',
  canManage: 'manage mailbox (move/archive)',
  canDelete: 'delete messages',
  canDownloadAttachments: 'download attachments',
}

function requireCapability(account: EmailAccount, capability: EmailCapability): ToolResult | null {
  if (account[capability]) return null
  return fail(
    `Account "${account.name}" is not allowed to ${CAPABILITY_LABEL[capability]} — the "${capability}" permission is disabled for this account. ` +
      'Ask the user to enable it in the email account settings.',
    { accountId: account.id, capability },
  )
}

function resolveUids(value: unknown): Resolution<number[]> {
  const raw = Array.isArray(value) ? value : [value]
  const uids: number[] = []
  for (const entry of raw) {
    const num = typeof entry === 'number' ? entry : Number(entry)
    if (!Number.isFinite(num) || num <= 0) {
      return { ok: false, error: fail('Parameter "uids" must be a non-empty array of positive UIDs (see email_list output).') }
    }
    uids.push(Math.floor(num))
  }

  const unique = [...new Set(uids)]
  if (unique.length === 0) {
    return { ok: false, error: fail('Parameter "uids" must be a non-empty array of positive UIDs (see email_list output).') }
  }
  if (unique.length > MAX_EMAIL_BULK_UIDS) {
    return { ok: false, error: fail(`Too many UIDs — at most ${MAX_EMAIL_BULK_UIDS} messages can be handled per call.`) }
  }
  return { ok: true, value: unique }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatSender(from: { name?: string; address: string }[]): string {
  return from.length > 0 ? from.map(formatAddress).join(', ') : '(unknown sender)'
}

export function createEmailListTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_list',
    label: 'List Emails',
    description:
      'List emails of a mailbox folder as metadata only (sender, subject, date, UID) — never full bodies. ' +
      `Defaults to unread messages in ${DEFAULT_EMAIL_FOLDER} with a limit of ${DEFAULT_EMAIL_LIST_LIMIT}. ` +
      'Use email_read with the UID to read a single message.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `IMAP folder path (default: ${DEFAULT_EMAIL_FOLDER}). Use email_folders to discover available folders.` }),
      ),
      unread_only: Type.Optional(
        Type.Boolean({ description: 'Only list unread messages. Default: true.' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Maximum number of messages to return (default: ${DEFAULT_EMAIL_LIST_LIMIT}, max: ${MAX_EMAIL_LIST_LIMIT}).` }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, unread_only, limit } = params as {
        account?: string
        folder?: string
        unread_only?: boolean
        limit?: number
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      const unseenOnly = unread_only !== false
      const effectiveLimit = Math.min(
        Math.max(1, Math.floor(limit ?? DEFAULT_EMAIL_LIST_LIMIT)),
        MAX_EMAIL_LIST_LIMIT,
      )

      try {
        const messages = await resolved.client.listMessages(toClientAccount(account.value), {
          folder: targetFolder.value,
          unseenOnly,
          limit: effectiveLimit,
        })

        if (messages.length === 0) {
          return ok(
            `No ${unseenOnly ? 'unread ' : ''}messages in "${targetFolder.value}" (account "${account.value.name}").`,
            { accountId: account.value.id, folder: targetFolder.value, count: 0 },
          )
        }

        const lines = messages.map(message => {
          const date = message.date ?? 'unknown date'
          const flags = message.seen ? '' : ' [unread]'
          return `• UID ${message.uid} | ${date} | ${formatSender(message.from)} | ${message.subject}${flags}`
        })

        return ok(
          `${messages.length} message(s) in "${targetFolder.value}" (account "${account.value.name}"):\n\n${lines.join('\n')}`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            count: messages.length,
            unreadOnly: unseenOnly,
            limit: effectiveLimit,
          },
        )
      } catch (err) {
        return fail(`Failed to list emails: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailFoldersTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_folders',
    label: 'List Email Folders',
    description:
      'List the folders of an email account. Only folders the account is allowed to access are returned. ' +
      'Use the returned paths as the "folder" parameter of email_list / email_read.',
    parameters: Type.Object({
      account: accountParam(),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue } = params as { account?: string }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      try {
        const folders = await resolved.client.listFolders(toClientAccount(account.value))
        const allowed = folders.filter(entry => isFolderAllowed(account.value, entry.path))

        if (allowed.length === 0) {
          return ok(`No accessible folders for account "${account.value.name}".`, {
            accountId: account.value.id,
            count: 0,
          })
        }

        const lines = allowed.map(entry => {
          const special = entry.specialUse ? ` (${entry.specialUse})` : ''
          return `• ${entry.path}${special}`
        })

        return ok(
          `${allowed.length} folder(s) for account "${account.value.name}":\n\n${lines.join('\n')}`,
          { accountId: account.value.id, count: allowed.length, folders: allowed.map(entry => entry.path) },
        )
      } catch (err) {
        return fail(`Failed to list folders: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailReadTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_read',
    label: 'Read Email',
    description:
      'Read a single email by UID including its full body (HTML is converted to plain text). ' +
      'The message is automatically marked as read. Use email_list first to get UIDs.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `IMAP folder path the message lives in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uid: Type.Number({ description: 'UID of the message, as returned by email_list.' }),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uid } = params as {
        account?: string
        folder?: string
        uid: number
      }

      if (typeof uid !== 'number' || !Number.isFinite(uid)) {
        return fail('Parameter "uid" must be a number (see email_list output).')
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      try {
        const message = await resolved.client.readMessage(
          toClientAccount(account.value),
          targetFolder.value,
          uid,
          { markSeen: true },
        )

        const attachments = message.attachments.length > 0
          ? message.attachments.map(a => `${a.filename} (${a.contentType}, ${a.size} bytes)`).join(', ')
          : 'none'

        const header = [
          `From: ${formatSender(message.from)}`,
          `To: ${message.to.map(formatAddress).join(', ') || '(none)'}`,
          message.cc.length > 0 ? `Cc: ${message.cc.map(formatAddress).join(', ')}` : null,
          `Date: ${message.date ?? 'unknown'}`,
          `Subject: ${message.subject}`,
          `Folder: ${targetFolder.value} | UID: ${message.uid} | Account: ${account.value.name}`,
          `Attachments: ${attachments}`,
        ].filter(Boolean).join('\n')

        return ok(`${header}\n\n${message.text || '(empty body)'}`, {
          accountId: account.value.id,
          folder: targetFolder.value,
          uid: message.uid,
          markedRead: true,
          attachments: message.attachments,
        })
      } catch (err) {
        return fail(`Failed to read email: ${errorText(err)}`)
      }
    },
  }
}

function createSetSeenTool(deps: EmailToolsDeps, seen: boolean): AgentTool {
  const resolved = resolveDeps(deps)
  const verb = seen ? 'read' : 'unread'

  return {
    name: seen ? 'email_mark_read' : 'email_mark_unread',
    label: seen ? 'Mark Emails Read' : 'Mark Emails Unread',
    description:
      `Mark one or more messages as ${verb} by UID without loading their bodies into the context. ` +
      'Pass several UIDs at once to handle a whole batch in a single call. Use email_list to get UIDs.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `IMAP folder the messages live in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uids: uidsParam(`UIDs of the messages to mark as ${verb}, as returned by email_list.`),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uids } = params as {
        account?: string
        folder?: string
        uids?: number[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      const targetUids = resolveUids(uids)
      if (!targetUids.ok) return targetUids.error

      try {
        const count = await resolved.client.setSeen(
          toClientAccount(account.value),
          targetFolder.value,
          targetUids.value,
          seen,
        )

        return ok(
          `Marked ${count} message(s) as ${verb} in "${targetFolder.value}" (account "${account.value.name}").`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            uids: targetUids.value,
            seen,
            count,
          },
        )
      } catch (err) {
        return fail(`Failed to mark messages as ${verb}: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailMarkReadTool(deps: EmailToolsDeps = {}): AgentTool {
  return createSetSeenTool(deps, true)
}

export function createEmailMarkUnreadTool(deps: EmailToolsDeps = {}): AgentTool {
  return createSetSeenTool(deps, false)
}

export function createEmailMoveTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_move',
    label: 'Move Emails',
    description:
      'Move (archive) one or more messages to another folder. Source and target folder must both be accessible for the account. ' +
      'Requires the account permission to manage the mailbox.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `Source folder the messages live in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      target_folder: Type.String({ description: 'Destination folder path, e.g. "Archive". Use email_folders to discover it.' }),
      uids: uidsParam('UIDs of the messages to move, as returned by email_list.'),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, target_folder, uids } = params as {
        account?: string
        folder?: string
        target_folder?: string
        uids?: number[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canManage')
      if (denied) return denied

      const sourceFolder = resolveFolder(account.value, folder)
      if (!sourceFolder.ok) return sourceFolder.error

      if (!target_folder?.trim()) {
        return fail('Parameter "target_folder" is required (use email_folders to discover folders).')
      }
      const targetFolder = resolveFolder(account.value, target_folder)
      if (!targetFolder.ok) return targetFolder.error

      if (targetFolder.value.toLowerCase() === sourceFolder.value.toLowerCase()) {
        return fail('Source and target folder are identical — nothing to move.')
      }

      const targetUids = resolveUids(uids)
      if (!targetUids.ok) return targetUids.error

      try {
        const count = await resolved.client.moveMessages(
          toClientAccount(account.value),
          sourceFolder.value,
          targetUids.value,
          targetFolder.value,
        )

        return ok(
          `Moved ${count} message(s) from "${sourceFolder.value}" to "${targetFolder.value}" (account "${account.value.name}").`,
          {
            accountId: account.value.id,
            folder: sourceFolder.value,
            targetFolder: targetFolder.value,
            uids: targetUids.value,
            count,
          },
        )
      } catch (err) {
        return fail(`Failed to move messages: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailDeleteTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_delete',
    label: 'Delete Emails',
    description:
      'Delete one or more messages by UID. Moves them to the trash folder when the server has one, otherwise deletes permanently. ' +
      'Requires the account permission to delete messages.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `Folder the messages live in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uids: uidsParam('UIDs of the messages to delete, as returned by email_list.'),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uids } = params as {
        account?: string
        folder?: string
        uids?: number[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canDelete')
      if (denied) return denied

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      const targetUids = resolveUids(uids)
      if (!targetUids.ok) return targetUids.error

      try {
        const count = await resolved.client.deleteMessages(
          toClientAccount(account.value),
          targetFolder.value,
          targetUids.value,
        )

        return ok(
          `Deleted ${count} message(s) in "${targetFolder.value}" (account "${account.value.name}").`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            uids: targetUids.value,
            count,
          },
        )
      } catch (err) {
        return fail(`Failed to delete messages: ${errorText(err)}`)
      }
    },
  }
}

/** Strips directory traversal so a hostile filename/config cannot escape the workspace. */
export function attachmentTargetDir(workspaceDir: string, account: EmailAccount): string {
  const configured = account.attachmentDownloadPath?.trim() || DEFAULT_ATTACHMENT_DOWNLOAD_PATH
  const candidate = path.resolve(workspaceDir, configured)
  const relative = path.relative(workspaceDir, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.join(workspaceDir, DEFAULT_ATTACHMENT_DOWNLOAD_PATH)
  }
  return candidate
}

export function safeAttachmentFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex -- control chars in a filename would corrupt the path
  const base = path.basename(filename.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim()
  const cleaned = base.replace(/^\.+/, '')
  return cleaned || 'attachment'
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = path.join(dir, filename)
  let counter = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${counter}${ext}`)
    counter += 1
  }
  return candidate
}

export function createEmailDownloadAttachmentTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_download_attachment',
    label: 'Download Email Attachment',
    description:
      'Download a single attachment of a message into the workspace and return its file path. ' +
      'Use email_read first to get the attachment part ids. Requires the account permission to download attachments.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `Folder the message lives in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uid: Type.Number({ description: 'UID of the message, as returned by email_list.' }),
      part_id: Type.String({ description: 'Attachment part id, as listed by email_read.' }),
      filename: Type.Optional(
        Type.String({ description: 'Override the file name used inside the workspace directory.' }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uid, part_id, filename } = params as {
        account?: string
        folder?: string
        uid?: number
        part_id?: string
        filename?: string
      }

      if (typeof uid !== 'number' || !Number.isFinite(uid)) {
        return fail('Parameter "uid" must be a number (see email_list output).')
      }
      if (!part_id?.trim()) {
        return fail('Parameter "part_id" is required (see the attachment list of email_read).')
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canDownloadAttachments')
      if (denied) return denied

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      try {
        const download = await resolved.client.downloadAttachment(
          toClientAccount(account.value),
          targetFolder.value,
          uid,
          part_id.trim(),
        )

        const dir = attachmentTargetDir(resolved.workspaceDir(), account.value)
        fs.mkdirSync(dir, { recursive: true })
        const targetPath = uniquePath(dir, safeAttachmentFilename(filename?.trim() || download.filename))
        fs.writeFileSync(targetPath, download.content)

        return ok(
          `Saved attachment "${path.basename(targetPath)}" (${download.contentType}, ${download.content.length} bytes) to ${targetPath}`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            uid,
            partId: part_id.trim(),
            path: targetPath,
            contentType: download.contentType,
            size: download.content.length,
          },
        )
      } catch (err) {
        return fail(`Failed to download attachment: ${errorText(err)}`)
      }
    },
  }
}

/** Signature/disclaimer is appended server-side — the agent cannot suppress it. */
export function appendSignature(body: string, signature: string): string {
  const trimmed = signature.trim()
  if (!trimmed) return body
  return `${body.replace(/\s+$/, '')}\n\n-- \n${trimmed}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function appendHtmlSignature(html: string, signature: string): string {
  const trimmed = signature.trim()
  if (!trimmed) return html
  return `${html}\n<br><br>--<br>\n${escapeHtml(trimmed).replace(/\n/g, '<br>\n')}`
}

/** Workspace-relative attachment path, rejecting anything outside the workspace. */
export function resolveWorkspaceFile(workspaceDir: string, requested: string): string | null {
  const candidate = path.resolve(workspaceDir, requested)
  const relative = path.relative(workspaceDir, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return candidate
}

function toStringList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw.map(entry => String(entry).trim()).filter(Boolean)
}

/**
 * Recipients are expanded to bare addresses before anything else happens, so the
 * allowlist check, the send log and SMTP all see the exact same list — a single
 * string may otherwise carry more recipients than it appears to.
 */
function toRecipientList(value: unknown): string[] {
  return toStringList(value).flatMap((entry) => {
    const parsed = parseAddressList(entry)
    return parsed.length > 0 ? parsed : [entry]
  })
}

export function createEmailSendTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_send',
    label: 'Send Email',
    description:
      'Send a new email or reply to an existing message. Recipients are checked server-side against the account allowlist: ' +
      'mails to non-allowlisted recipients are either blocked or held for human approval. Every attempt is recorded in the send log. ' +
      'The account signature/disclaimer is always appended automatically.',
    parameters: Type.Object({
      account: accountParam(),
      to: Type.Optional(Type.Array(Type.String(), { description: 'Primary recipients. Optional when replying — defaults to the sender of the original message.' })),
      cc: Type.Optional(Type.Array(Type.String(), { description: 'CC recipients.' })),
      bcc: Type.Optional(Type.Array(Type.String(), { description: 'BCC recipients.' })),
      subject: Type.Optional(Type.String({ description: 'Subject. Optional when replying — defaults to "Re: <original subject>".' })),
      body: Type.String({ description: 'Plain text body. The account signature is appended automatically.' }),
      html_body: Type.Optional(Type.String({ description: 'Optional HTML body. Ignored when HTML sending is disabled for the account.' })),
      reply_to_uid: Type.Optional(Type.Number({ description: 'UID of the message to reply to (keeps the thread intact via In-Reply-To/References).' })),
      folder: Type.Optional(Type.String({ description: `Folder of the message referenced by reply_to_uid (default: ${DEFAULT_EMAIL_FOLDER}).` })),
      attachments: Type.Optional(Type.Array(Type.String(), { description: 'Workspace-relative file paths to attach.' })),
    }),
    execute: async (_toolCallId, params) => {
      const {
        account: accountParamValue,
        to,
        cc,
        bcc,
        subject,
        body,
        html_body,
        reply_to_uid,
        folder,
        attachments,
      } = params as {
        account?: string
        to?: string[]
        cc?: string[]
        bcc?: string[]
        subject?: string
        body?: string
        html_body?: string
        reply_to_uid?: number
        folder?: string
        attachments?: string[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canSend')
      if (denied) return denied

      if (typeof body !== 'string' || !body.trim()) {
        return fail('Parameter "body" is required and must not be empty.')
      }

      let recipientsTo = toRecipientList(to)
      let effectiveSubject = subject?.trim() ?? ''
      let inReplyTo: string | null = null
      let references: string[] = []

      if (reply_to_uid !== undefined) {
        if (typeof reply_to_uid !== 'number' || !Number.isFinite(reply_to_uid)) {
          return fail('Parameter "reply_to_uid" must be a number (see email_list output).')
        }

        const sourceFolder = resolveFolder(account.value, folder)
        if (!sourceFolder.ok) return sourceFolder.error

        try {
          const original = await resolved.client.readMessage(
            toClientAccount(account.value),
            sourceFolder.value,
            reply_to_uid,
            { markSeen: false },
          )

          if (recipientsTo.length === 0) {
            recipientsTo = original.from.map(entry => entry.address)
          }
          if (!effectiveSubject) {
            effectiveSubject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`
          }
          inReplyTo = original.messageId ?? null
          references = [...original.references, ...(original.messageId ? [original.messageId] : [])]
        } catch (err) {
          return fail(`Failed to load the message to reply to: ${errorText(err)}`)
        }
      }

      if (!effectiveSubject) {
        return fail('Parameter "subject" is required for new messages.')
      }

      const recipientsCc = toRecipientList(cc)
      const recipientsBcc = toRecipientList(bcc)

      const workspaceDir = resolved.workspaceDir()
      const attachmentMeta: EmailSendLogAttachment[] = []
      const outgoingAttachments: EmailOutgoingAttachment[] = []
      for (const requested of toStringList(attachments)) {
        const filePath = resolveWorkspaceFile(workspaceDir, requested)
        if (!filePath) {
          return fail(`Attachment "${requested}" is outside the workspace — only workspace-relative paths can be attached.`)
        }
        let size: number
        try {
          const stat = fs.statSync(filePath)
          if (!stat.isFile()) return fail(`Attachment "${requested}" is not a file.`)
          size = stat.size
        } catch {
          return fail(`Attachment "${requested}" was not found in the workspace.`)
        }
        const filename = path.basename(filePath)
        attachmentMeta.push({ filename, path: filePath, size })
        outgoingAttachments.push({ filename, path: filePath })
      }

      const text = appendSignature(body, account.value.signature)
      const htmlAllowed = account.value.allowHtml && Boolean(html_body?.trim())
      const html = htmlAllowed ? appendHtmlSignature(html_body!, account.value.signature) : null
      const htmlDropped = Boolean(html_body?.trim()) && !account.value.allowHtml

      const policy = evaluateEmailSendPolicy(
        { to: recipientsTo, cc: recipientsCc, bcc: recipientsBcc },
        { allowlist: account.value.allowlist, requireApproval: account.value.requireApproval },
      )

      const logBase = {
        accountId: account.value.id,
        accountName: account.value.name,
        to: recipientsTo,
        cc: recipientsCc,
        bcc: recipientsBcc,
        subject: effectiveSubject,
        bodyText: text,
        bodyHtml: html,
        attachments: attachmentMeta,
        inReplyTo,
        references,
      }

      if (policy.decision === 'blocked') {
        const entry = resolved.logSend({ ...logBase, status: 'blocked', reason: policy.reason })
        return fail(
          `Email was blocked by the send rules of account "${account.value.name}": ${policy.reason} ` +
            'Ask the user to add the recipient to the allowlist. The attempt was recorded in the send log.',
          { accountId: account.value.id, logId: entry.id, status: 'blocked', reason: policy.reason },
        )
      }

      if (policy.decision === 'pending') {
        const entry = resolved.logSend({ ...logBase, status: 'pending', reason: policy.reason })
        await notifyEmailApprovalRequested(entry)
        return ok(
          `Email is waiting for human approval (account "${account.value.name}"): ${policy.reason} ` +
            'It will be sent automatically once approved — do not retry.',
          { accountId: account.value.id, logId: entry.id, status: 'pending', reason: policy.reason },
        )
      }

      try {
        const result = await resolved.client.sendMessage(toClientAccount(account.value), {
          to: recipientsTo,
          cc: recipientsCc,
          bcc: recipientsBcc,
          subject: effectiveSubject,
          text,
          ...(html ? { html } : {}),
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(references.length > 0 ? { references } : {}),
          ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
          appendToSentFolder: account.value.appendToSentFolder,
        })

        const entry = resolved.logSend({
          ...logBase,
          status: 'sent',
          reason: policy.reason,
          messageId: result.messageId,
        })

        const notes = htmlDropped ? ' HTML sending is disabled for this account — sent as plain text.' : ''
        return ok(
          `Email sent to ${recipientsTo.join(', ')} (account "${account.value.name}", subject "${effectiveSubject}").${notes}`,
          {
            accountId: account.value.id,
            logId: entry.id,
            status: 'sent',
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            appendedToSent: result.appendedToSent,
          },
        )
      } catch (err) {
        const message = errorText(err)
        const entry = resolved.logSend({ ...logBase, status: 'failed', errorMessage: message })
        return fail(`Failed to send email: ${message}`, {
          accountId: account.value.id,
          logId: entry.id,
          status: 'failed',
        })
      }
    },
  }
}

/**
 * Email tools available to the agent. Returns an empty array when no account is
 * configured, and only registers capability-gated tools when at least one
 * account grants them — the per-account check still runs on every call.
 */
export function createEmailTools(deps: EmailToolsDeps = {}): AgentTool[] {
  const resolved = resolveDeps(deps)
  // A single unreadable account must not take the whole tool set (and with it
  // the agent) down; the per-call path reports the real reason.
  const accounts = resolved.listAccounts()
    .map(entry => {
      try {
        return resolved.getAccount(entry.id)
      } catch (err) {
        console.error(`[axiom] Email account "${entry.name}" could not be loaded: ${errorText(err)}`)
        return null
      }
    })
    .filter((entry): entry is EmailAccount => entry !== null)
  if (accounts.length === 0) return []

  const tools = [
    createEmailListTool(resolved),
    createEmailFoldersTool(resolved),
    createEmailReadTool(resolved),
    createEmailMarkReadTool(resolved),
    createEmailMarkUnreadTool(resolved),
  ]

  if (accounts.some(account => account.canSend)) tools.push(createEmailSendTool(resolved))
  if (accounts.some(account => account.canManage)) tools.push(createEmailMoveTool(resolved))
  if (accounts.some(account => account.canDelete)) tools.push(createEmailDeleteTool(resolved))
  if (accounts.some(account => account.canDownloadAttachments)) {
    tools.push(createEmailDownloadAttachmentTool(resolved))
  }

  return tools
}
