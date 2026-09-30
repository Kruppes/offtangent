import type { EmailSendLogEntry } from '@axiom/core'

/**
 * Rendering + callback-data helpers for the Telegram approval channel.
 * Kept separate from the bot so the formatting can be unit-tested without a
 * grammY instance.
 */

export const EMAIL_APPROVAL_CALLBACK_PREFIX = 'mail:'

export type EmailApprovalAction = 'approve' | 'reject'

const ACTION_CODES: Record<EmailApprovalAction, string> = {
  approve: 'a',
  reject: 'r',
}

/** Telegram caps `callback_data` at 64 bytes — `mail:a:<uuid>` fits in 43. */
export function buildEmailApprovalCallbackData(action: EmailApprovalAction, entryId: string): string {
  return `${EMAIL_APPROVAL_CALLBACK_PREFIX}${ACTION_CODES[action]}:${entryId}`
}

export function parseEmailApprovalCallbackData(
  data: string,
): { action: EmailApprovalAction; entryId: string } | null {
  if (!data.startsWith(EMAIL_APPROVAL_CALLBACK_PREFIX)) return null
  const rest = data.slice(EMAIL_APPROVAL_CALLBACK_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator < 0) return null

  const code = rest.slice(0, separator)
  const entryId = rest.slice(separator + 1)
  if (!entryId) return null

  const action = (Object.keys(ACTION_CODES) as EmailApprovalAction[])
    .find(key => ACTION_CODES[key] === code)

  return action ? { action, entryId } : null
}

const BODY_PREVIEW_MAX_LENGTH = 400

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}\u2026` : trimmed
}

function detailLines(entry: EmailSendLogEntry): string[] {
  const lines = [
    `<b>Account:</b> ${escapeHtml(entry.accountName)}`,
    `<b>To:</b> ${escapeHtml(entry.to.join(', '))}`,
  ]

  if (entry.cc.length > 0) lines.push(`<b>Cc:</b> ${escapeHtml(entry.cc.join(', '))}`)
  if (entry.bcc.length > 0) lines.push(`<b>Bcc:</b> ${escapeHtml(entry.bcc.join(', '))}`)
  lines.push(`<b>Subject:</b> ${escapeHtml(entry.subject)}`)

  for (const attachment of entry.attachments) {
    lines.push(`<b>Attachment:</b> ${escapeHtml(attachment.filename)} (${formatFileSize(attachment.size)})`)
  }

  if (entry.reason) lines.push(`<b>Reason:</b> ${escapeHtml(entry.reason)}`)

  return lines
}

/** The prompt shown together with the Accept/Cancel inline keyboard. */
export function formatEmailApprovalRequest(entry: EmailSendLogEntry): string {
  const body = truncate(entry.bodyText, BODY_PREVIEW_MAX_LENGTH)
  const lines = ['\u2709\uFE0F <b>Email waiting for approval</b>', '', ...detailLines(entry)]
  if (body) lines.push('', `<blockquote>${escapeHtml(body)}</blockquote>`)
  return lines.join('\n')
}

/**
 * The message the prompt is edited into once any channel decided — the
 * keyboard is dropped so stale buttons cannot be tapped again.
 */
export function formatEmailApprovalResolution(entry: EmailSendLogEntry): string {
  const who = entry.decidedBy ? ` by ${escapeHtml(entry.decidedBy)}` : ''

  const headline = entry.status === 'rejected'
    ? `\uD83D\uDEAB <b>Email rejected</b>${who}`
    : entry.status === 'failed'
      ? `\u26A0\uFE0F <b>Email approved${who} but sending failed</b>`
      : entry.status === 'sent'
        ? `\u2705 <b>Email approved${who} and sent</b>`
        : `\u2705 <b>Email approved</b>${who}`

  const lines = [headline, '', ...detailLines(entry)]
  if (entry.status === 'failed' && entry.errorMessage) {
    lines.push('', `<b>Error:</b> ${escapeHtml(entry.errorMessage)}`)
  }
  return lines.join('\n')
}
