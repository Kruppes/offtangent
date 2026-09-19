import { ImapFlow } from 'imapflow'
import type { FetchMessageObject, MessageStructureObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { ParsedMail } from 'mailparser'
import nodemailer from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser/index.js'

/**
 * Deep module encapsulating all IMAP/SMTP details. No other module may import
 * imapflow / mailparser / nodemailer — everything goes through this interface.
 */

export type EmailSecurity = 'ssl' | 'starttls' | 'none'

export interface EmailClientAccount {
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
  displayName?: string
  appendToSentFolder?: boolean
}

export interface EmailAddress {
  name?: string
  address: string
}

export interface EmailFolder {
  path: string
  name: string
  delimiter: string
  specialUse?: string
  subscribed: boolean
}

export interface EmailAttachmentInfo {
  partId: string
  filename: string
  contentType: string
  size: number
}

export interface EmailMessageSummary {
  uid: number
  folder: string
  subject: string
  from: EmailAddress[]
  to: EmailAddress[]
  date: string | null
  seen: boolean
  flagged: boolean
  size: number
}

export interface EmailMessage extends EmailMessageSummary {
  cc: EmailAddress[]
  messageId?: string
  inReplyTo?: string
  references: string[]
  text: string
  attachments: EmailAttachmentInfo[]
}

export interface EmailListOptions {
  folder?: string
  unseenOnly?: boolean
  limit?: number
}

export interface EmailOutgoingAttachment {
  filename: string
  path?: string
  content?: Buffer | string
  contentType?: string
}

export interface EmailSendInput {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  html?: string
  inReplyTo?: string
  references?: string[]
  attachments?: EmailOutgoingAttachment[]
  appendToSentFolder?: boolean
  sentFolder?: string
}

export interface EmailSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
  appendedToSent: boolean
}

export interface EmailConnectionCheck {
  ok: boolean
  error?: string
}

export interface EmailConnectionTestResult {
  imap?: EmailConnectionCheck
  smtp?: EmailConnectionCheck
}

export type EmailProtocol = 'imap' | 'smtp'

export interface EmailAttachmentDownload {
  filename: string
  contentType: string
  content: Buffer
}

export interface EmailClient {
  testConnection: (account: EmailClientAccount, protocol?: EmailProtocol) => Promise<EmailConnectionTestResult>
  listFolders: (account: EmailClientAccount) => Promise<EmailFolder[]>
  listMessages: (account: EmailClientAccount, options?: EmailListOptions) => Promise<EmailMessageSummary[]>
  readMessage: (
    account: EmailClientAccount,
    folder: string,
    uid: number,
    options?: { markSeen?: boolean },
  ) => Promise<EmailMessage>
  setSeen: (account: EmailClientAccount, folder: string, uids: number[], seen: boolean) => Promise<number>
  moveMessages: (account: EmailClientAccount, folder: string, uids: number[], targetFolder: string) => Promise<number>
  deleteMessages: (account: EmailClientAccount, folder: string, uids: number[]) => Promise<number>
  downloadAttachment: (
    account: EmailClientAccount,
    folder: string,
    uid: number,
    partId: string,
  ) => Promise<EmailAttachmentDownload>
  sendMessage: (account: EmailClientAccount, input: EmailSendInput) => Promise<EmailSendResult>
}

const DEFAULT_LIST_LIMIT = 50
const DEFAULT_FOLDER = 'INBOX'
const DEFAULT_SENT_FOLDER = 'Sent'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a server)
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function pickTrashFolder(
  folders: Array<{ path: string; specialUse?: string | undefined }>,
  currentFolder: string,
): string | null {
  const trash =
    folders.find(f => f.specialUse === '\\Trash') ??
    folders.find(f => /^(trash|papierkorb|deleted items|deleted messages)$/i.test(f.path))
  if (!trash || trash.path === currentFolder) return null
  return trash.path
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
}

/** Best-effort HTML → plaintext conversion for agent consumption. */
export function htmlToText(html: string): string {
  if (!html) return ''

  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '')

  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Lowercased bare address, tolerating `Name <addr>` and surrounding whitespace. */
export function normalizeAddress(value: string): string {
  const match = /<([^>]*)>/.exec(value)
  return (match?.[1] ?? value).trim().toLowerCase()
}

/**
 * Expands one recipient field value into the bare addresses it will actually be
 * delivered to, using the same parser nodemailer uses when sending.
 *
 * Checking anything else against the allowlist is exploitable: both
 * `evil@bad.com, ok@allowed.com` and `"x <ok@allowed.com>" <evil@bad.com>` look
 * like a single allowed recipient to a naive `<…>`/lowercase normalisation,
 * while SMTP still delivers to the smuggled address.
 */
export function parseAddressList(value: string): string[] {
  return addressparser(String(value), { flatten: true })
    .map(entry => normalizeAddress(entry.address ?? ''))
    .filter(Boolean)
}

export function addressDomain(value: string): string {
  const normalized = normalizeAddress(value)
  const at = normalized.lastIndexOf('@')
  return at === -1 ? '' : normalized.slice(at + 1)
}

export function formatAddress(address: EmailAddress): string {
  const name = address.name?.trim()
  return name ? `${name} <${address.address}>` : address.address
}

interface RawAddress {
  name?: string
  address?: string
}

export function mapAddresses(list: RawAddress[] | undefined): EmailAddress[] {
  if (!Array.isArray(list)) return []
  return list
    .filter(entry => entry?.address)
    .map(entry => {
      const mapped: EmailAddress = { address: normalizeAddress(entry.address!) }
      const name = entry.name?.trim()
      if (name) mapped.name = name
      return mapped
    })
}

export function parseReferences(value: string | string[] | undefined): string[] {
  if (!value) return []
  const raw = Array.isArray(value) ? value.join(' ') : value
  return raw.split(/\s+/).map(entry => entry.trim()).filter(Boolean)
}

/** Flattens a BODYSTRUCTURE tree into downloadable attachment descriptors. */
export function collectAttachmentParts(
  node: MessageStructureObject | undefined,
  out: EmailAttachmentInfo[] = [],
): EmailAttachmentInfo[] {
  if (!node) return out

  const disposition = node.disposition?.toLowerCase()
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name
  if (node.part && (disposition === 'attachment' || (filename && disposition !== 'inline'))) {
    out.push({
      partId: node.part,
      filename: filename ?? `part-${node.part}`,
      contentType: node.type ?? 'application/octet-stream',
      size: node.size ?? 0,
    })
  }

  for (const child of node.childNodes ?? []) {
    collectAttachmentParts(child, out)
  }
  return out
}

/** Turns raw IMAP/SMTP failures into messages a human can act on. */
export function describeConnectionError(err: unknown, protocol: 'IMAP' | 'SMTP'): string {
  const error = err as { code?: string; responseCode?: number; message?: string; responseText?: string }
  const code = error?.code ?? ''
  // imapflow throws a generic "Command failed" and keeps the server's reason in
  // responseText — without it every IMAP rejection looks identical.
  const message = [error?.message ?? String(err), error?.responseText].filter(Boolean).join(': ')

  if (code === 'ECONNREFUSED') {
    return `${protocol}: connection refused — check host and port.`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${protocol}: host not found — check the hostname.`
  }
  if (code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT' || (code === 'ESOCKET' && /timeout/i.test(message))) {
    return `${protocol}: connection timed out — check host, port and firewall.`
  }
  if (/self[- ]signed|SELF_SIGNED_CERT|DEPTH_ZERO/i.test(code + message)) {
    return `${protocol}: the server uses a self-signed certificate — enable "accept self-signed certificate" for this account.`
  }
  if (/certificate|ERR_TLS|altname|wrong version number/i.test(code + message)) {
    return `${protocol}: TLS error (${message}) — check the port and TLS settings.`
  }
  if (code === 'AUTHENTICATIONFAILED' || code === 'EAUTH' || /auth/i.test(code + message)) {
    return `${protocol}: authentication failed — check username and password.`
  }

  return `${protocol}: ${message}`
}

// ---------------------------------------------------------------------------
// Connection wiring
// ---------------------------------------------------------------------------

function imapOptions(account: EmailClientAccount) {
  const security = account.imapSecurity
  return {
    host: account.imapHost,
    port: account.imapPort,
    secure: security === 'ssl',
    // imapflow upgrades to STARTTLS whenever the server offers it unless told otherwise
    doSTARTTLS: security === 'none' ? false : security === 'starttls',
    auth: { user: account.imapUser, pass: account.imapPassword },
    tls: { rejectUnauthorized: !account.allowSelfSignedCert },
    logger: false as const,
  }
}

function smtpTransport(account: EmailClientAccount) {
  const security = account.smtpSecurity
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: security === 'ssl',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: account.smtpUser ? { user: account.smtpUser, pass: account.smtpPassword } : undefined,
    tls: { rejectUnauthorized: !account.allowSelfSignedCert },
  })
}

async function withImap<T>(account: EmailClientAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow(imapOptions(account))
  try {
    await client.connect()
  } catch (err) {
    throw new Error(describeConnectionError(err, 'IMAP'))
  }

  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => client.close())
  }
}

async function withMailbox<T>(
  account: EmailClientAccount,
  folder: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  return withImap(account, async client => {
    const lock = await client.getMailboxLock(folder)
    try {
      return await fn(client)
    } finally {
      lock.release()
    }
  })
}

function toSummary(message: FetchMessageObject, folder: string): EmailMessageSummary {
  const envelope = message.envelope
  return {
    uid: message.uid,
    folder,
    subject: envelope?.subject ?? '(no subject)',
    from: mapAddresses(envelope?.from),
    to: mapAddresses(envelope?.to),
    date: envelope?.date ? new Date(envelope.date).toISOString() : null,
    seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false,
    size: message.size ?? 0,
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

function fromAddress(account: EmailClientAccount): string {
  const name = account.displayName?.trim()
  return name ? `${name} <${account.smtpUser}>` : account.smtpUser
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createEmailClient(): EmailClient {
  return {
    async testConnection(account, protocol) {
      const result: EmailConnectionTestResult = {}

      if (protocol !== 'smtp') {
        try {
          await withImap(account, async client => {
            await client.noop()
          })
          result.imap = { ok: true }
        } catch (err) {
          result.imap = { ok: false, error: (err as Error).message }
        }
      }

      if (protocol !== 'imap') {
        const transport = smtpTransport(account)
        try {
          await transport.verify()
          result.smtp = { ok: true }
        } catch (err) {
          result.smtp = { ok: false, error: describeConnectionError(err, 'SMTP') }
        } finally {
          transport.close()
        }
      }

      return result
    },

    async listFolders(account) {
      return withImap(account, async client => {
        const folders = await client.list()
        return folders.map(folder => {
          const mapped: EmailFolder = {
            path: folder.path,
            name: folder.name,
            delimiter: folder.delimiter,
            subscribed: folder.subscribed !== false,
          }
          if (folder.specialUse) mapped.specialUse = folder.specialUse
          return mapped
        })
      })
    },

    async listMessages(account, options = {}) {
      const folder = options.folder || DEFAULT_FOLDER
      const limit = Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT)

      return withMailbox(account, folder, async client => {
        const uids = await client.search(options.unseenOnly === false ? { all: true } : { seen: false }, { uid: true })
        if (!uids || uids.length === 0) return []

        const selected = (uids as number[]).slice(-limit)
        const messages: EmailMessageSummary[] = []
        for await (const message of client.fetch(
          selected,
          { uid: true, envelope: true, flags: true, size: true },
          { uid: true },
        )) {
          messages.push(toSummary(message, folder))
        }

        return messages.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      })
    },

    async readMessage(account, folder, uid, options = {}) {
      return withMailbox(account, folder, async client => {
        const message = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, source: true },
          { uid: true },
        )
        if (!message) throw new Error(`Message ${uid} not found in folder "${folder}"`)

        const parsed: ParsedMail = await simpleParser(message.source ?? Buffer.alloc(0))
        const text = parsed.text?.trim() || htmlToText(parsed.html || '')

        if (options.markSeen !== false) {
          await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true })
        }

        const summary = toSummary(message, folder)
        const detail: EmailMessage = {
          ...summary,
          seen: options.markSeen !== false ? true : summary.seen,
          cc: mapAddresses(message.envelope?.cc),
          references: parseReferences(parsed.references),
          text,
          attachments: collectAttachmentParts(message.bodyStructure),
        }

        const messageId = message.envelope?.messageId
        if (messageId) detail.messageId = messageId
        const inReplyTo = message.envelope?.inReplyTo
        if (inReplyTo) detail.inReplyTo = inReplyTo

        return detail
      })
    },

    async setSeen(account, folder, uids, seen) {
      if (uids.length === 0) return 0
      return withMailbox(account, folder, async client => {
        if (seen) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
        else await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true })
        return uids.length
      })
    },

    async moveMessages(account, folder, uids, targetFolder) {
      if (uids.length === 0) return 0
      return withMailbox(account, folder, async client => {
        await client.messageMove(uids, targetFolder, { uid: true })
        return uids.length
      })
    },

    async deleteMessages(account, folder, uids) {
      if (uids.length === 0) return 0
      return withMailbox(account, folder, async client => {
        const trash = pickTrashFolder(await client.list(), folder)
        if (trash) await client.messageMove(uids, trash, { uid: true })
        else await client.messageDelete(uids, { uid: true })
        return uids.length
      })
    },

    async downloadAttachment(account, folder, uid, partId) {
      return withMailbox(account, folder, async client => {
        const download = await client.download(String(uid), partId, { uid: true })
        if (!download?.content) throw new Error(`Attachment part "${partId}" not found in message ${uid}`)

        return {
          filename: download.meta.filename ?? `part-${partId}`,
          contentType: download.meta.contentType ?? 'application/octet-stream',
          content: await streamToBuffer(download.content),
        }
      })
    },

    async sendMessage(account, input) {
      const transport = smtpTransport(account)
      let sent: { messageId: string; accepted: string[]; rejected: string[] }

      try {
        const info = await transport.sendMail({
          from: fromAddress(account),
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          inReplyTo: input.inReplyTo,
          references: input.references,
          attachments: input.attachments,
        })

        sent = {
          messageId: info.messageId,
          accepted: (info.accepted ?? []).map(entry => String(entry)),
          rejected: (info.rejected ?? []).map(entry => String(entry)),
        }
      } catch (err) {
        throw new Error(describeConnectionError(err, 'SMTP'))
      } finally {
        transport.close()
      }

      const shouldAppend = input.appendToSentFolder ?? account.appendToSentFolder ?? false
      let appendedToSent = false
      if (shouldAppend) {
        try {
          const raw = await buildRawMessage(account, input)
          await withImap(account, async client => {
            await client.append(input.sentFolder || DEFAULT_SENT_FOLDER, raw, ['\\Seen'])
          })
          appendedToSent = true
        } catch (err) {
          console.warn(`[axiom] Failed to append sent message to IMAP: ${(err as Error).message}`)
        }
      }

      return {
        messageId: sent.messageId,
        accepted: sent.accepted,
        rejected: sent.rejected,
        appendedToSent,
      }
    },
  }
}

async function buildRawMessage(account: EmailClientAccount, input: EmailSendInput): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true })
  const info = await transport.sendMail({
    from: fromAddress(account),
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments,
  })
  return info.message as Buffer
}
