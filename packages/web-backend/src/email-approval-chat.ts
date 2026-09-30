import { registerEmailApprovalNotifier } from '@axiom/core'
import type { EmailApprovalService, EmailSendLogEntry } from '@axiom/core'
import type { ChatActionRegistry } from './chat-actions.js'

/**
 * Webchat channel for email approvals: publishes an interactive chat message
 * with Accept/Cancel for every pending email and turns it into a result line
 * once any channel (web UI, Telegram, chat) decided.
 */

export const EMAIL_APPROVAL_CHAT_KIND = 'email_approval'

const BODY_PREVIEW_MAX_LENGTH = 400

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
  const lines = [`Account: ${entry.accountName}`, `To: ${entry.to.join(', ')}`]

  if (entry.cc.length > 0) lines.push(`Cc: ${entry.cc.join(', ')}`)
  if (entry.bcc.length > 0) lines.push(`Bcc: ${entry.bcc.join(', ')}`)
  lines.push(`Subject: ${entry.subject}`)

  for (const attachment of entry.attachments) {
    lines.push(`Attachment: ${attachment.filename} (${formatFileSize(attachment.size)})`)
  }

  if (entry.reason) lines.push(`Reason: ${entry.reason}`)

  return lines
}

function formatEmailApprovalRequestText(entry: EmailSendLogEntry): string {
  const body = truncate(entry.bodyText, BODY_PREVIEW_MAX_LENGTH)
  const lines = ['\u2709\uFE0F Email waiting for approval', '', ...detailLines(entry)]
  if (body) lines.push('', body)
  return lines.join('\n')
}

function formatEmailApprovalResolutionText(entry: EmailSendLogEntry): string {
  const who = entry.decidedBy ? ` by ${entry.decidedBy}` : ''

  if (entry.status === 'rejected') return `\uD83D\uDEAB Rejected${who}`
  if (entry.status === 'failed') {
    const error = entry.errorMessage ? `: ${entry.errorMessage}` : ''
    return `\u26A0\uFE0F Approved${who}, but sending failed${error}`
  }
  if (entry.status === 'sent') return `\u2705 Approved${who} and sent`
  return `\u2705 Approved${who}`
}

export interface EmailApprovalChatChannelDeps {
  chatActions: ChatActionRegistry
  approval: EmailApprovalService
}

/**
 * Wires the registry into the core approval boundary. Returns an unregister
 * function that detaches both the notifier and the action handler.
 */
export function registerEmailApprovalChatChannel(deps: EmailApprovalChatChannelDeps): () => void {
  const unregisterHandler = deps.chatActions.registerHandler(
    EMAIL_APPROVAL_CHAT_KIND,
    async ({ refId, actionId, user }) => {
      const decider = { name: user.username }
      const result = actionId === 'reject'
        ? await deps.approval.reject(refId, decider)
        : await deps.approval.approve(refId, decider)

      // On failure the service message is the informative one ("already
      // decided by X", SMTP error, …); the entry alone would not show that
      // this click lost the race.
      return result.ok
        ? { ok: true, resolution: formatEmailApprovalResolutionText(result.entry) }
        : { ok: false, resolution: result.message }
    },
  )

  const unregisterNotifier = registerEmailApprovalNotifier({
    approvalRequested: (entry) => {
      if (entry.status !== 'pending') return
      deps.chatActions.publish({
        kind: EMAIL_APPROVAL_CHAT_KIND,
        refId: entry.id,
        text: formatEmailApprovalRequestText(entry),
        actions: [
          { actionId: 'approve', label: 'Accept', style: 'primary' },
          { actionId: 'reject', label: 'Cancel', style: 'danger' },
        ],
      })
    },
    approvalResolved: (entry) => {
      deps.chatActions.resolve(EMAIL_APPROVAL_CHAT_KIND, entry.id, formatEmailApprovalResolutionText(entry))
    },
  })

  return () => {
    unregisterHandler()
    unregisterNotifier()
  }
}
