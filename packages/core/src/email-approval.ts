import { getEmailAccountDecrypted } from './email-account-store.js'
import type { EmailAccount } from './email-account-store.js'
import { createEmailClient } from './email-client.js'
import type { EmailClient, EmailOutgoingAttachment } from './email-client.js'
import { notifyEmailApprovalResolved } from './email-approval-notifier.js'
import { getEmailSendLogEntry } from './email-send-log.js'
import type { EmailSendLogEntry } from './email-send-log.js'
import { toClientAccount } from './email-tools.js'
import type { Database } from './database.js'

/**
 * Approve/reject/retry orchestration for send log entries that wait for a human
 * decision. The status change is a conditional UPDATE so two concurrent
 * decisions (web, chat, telegram) cannot both win — the loser gets
 * `already_decided`. Sending happens here, without involving the agent again.
 */

export interface EmailApprovalDecider {
  /** Stable identity of the deciding user, used for the audit trail. */
  name: string
}

export type EmailApprovalErrorCode =
  | 'not_found'
  | 'already_decided'
  | 'not_retryable'
  | 'account_missing'
  | 'send_failed'

export type EmailApprovalResult =
  | { ok: true; entry: EmailSendLogEntry }
  | { ok: false; code: EmailApprovalErrorCode; message: string; entry: EmailSendLogEntry | null }

export interface EmailApprovalDeps {
  db: Database
  client?: EmailClient
  getAccount?: (id: string) => EmailAccount | null
}

interface ResolvedDeps {
  db: Database
  client: EmailClient
  getAccount: (id: string) => EmailAccount | null
}

function resolveDeps(deps: EmailApprovalDeps): ResolvedDeps {
  return {
    db: deps.db,
    client: deps.client ?? createEmailClient(),
    getAccount: deps.getAccount ?? getEmailAccountDecrypted,
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function decidedLabel(entry: EmailSendLogEntry): string {
  const who = entry.decidedBy ? ` by ${entry.decidedBy}` : ''
  return `This email was already decided${who} (status: ${entry.status}).`
}

/**
 * Conditional status transition — returns null when the row was not in one of
 * the expected source states, which is how first-action-wins is enforced.
 */
function transition(
  db: Database,
  id: string,
  from: EmailSendLogEntry['status'][],
  to: EmailSendLogEntry['status'],
  decider?: EmailApprovalDecider,
): EmailSendLogEntry | null {
  const now = new Date().toISOString()
  const placeholders = from.map(() => '?').join(', ')
  const assignments = ['status = ?', 'updated_at = ?']
  const params: unknown[] = [to, now]

  if (decider) {
    assignments.push('decided_by = ?', 'decided_at = ?')
    params.push(decider.name, now)
  }

  const result = db.prepare(
    `UPDATE email_send_log SET ${assignments.join(', ')} WHERE id = ? AND status IN (${placeholders})`,
  ).run(...params, id, ...from)

  return result.changes > 0 ? getEmailSendLogEntry(db, id) : null
}

function toOutgoingAttachments(entry: EmailSendLogEntry): EmailOutgoingAttachment[] {
  return entry.attachments
    .filter(attachment => Boolean(attachment.path))
    .map(attachment => ({ filename: attachment.filename, path: attachment.path! }))
}

function markFailed(db: Database, id: string, message: string): EmailSendLogEntry | null {
  db.prepare('UPDATE email_send_log SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
    .run('failed', message, new Date().toISOString(), id)
  return getEmailSendLogEntry(db, id)
}

/**
 * Entries flipped to `approved` whose send never reached a terminal state (the
 * process died mid-send) are otherwise invisible forever: no longer pending, so
 * no approval buttons, and `retry` only accepts failed ones. Recovering them at
 * service construction (i.e. process start) turns them into a retryable failure.
 * The threshold is generous on purpose so a send that is still running in
 * another process is never stolen.
 */
const STUCK_APPROVED_AFTER_MS = 10 * 60 * 1000

const STUCK_APPROVED_MESSAGE =
  'Sending was interrupted before the result was known — retry to send it.'

export function recoverStuckApprovedEmails(db: Database, now: number = Date.now()): number {
  const cutoff = new Date(now - STUCK_APPROVED_AFTER_MS).toISOString()
  const result = db.prepare(
    `UPDATE email_send_log SET status = 'failed', error_message = ?, updated_at = ?
     WHERE status = 'approved' AND message_id IS NULL AND updated_at < ?`,
  ).run(STUCK_APPROVED_MESSAGE, new Date(now).toISOString(), cutoff)
  return result.changes
}

function loadAccount(deps: ResolvedDeps, entry: EmailSendLogEntry): EmailApprovalResult | EmailAccount {
  let account: EmailAccount | null
  try {
    account = deps.getAccount(entry.accountId)
  } catch (err) {
    // Unreadable credentials (e.g. a rotated encryption key) must not look like
    // an SMTP problem — surface the real reason on the entry.
    const message = `Email account "${entry.accountName}" could not be loaded: ${errorText(err)}`
    return { ok: false, code: 'account_missing', message, entry: markFailed(deps.db, entry.id, message) }
  }

  if (!account) {
    const message = `Email account "${entry.accountName}" no longer exists — the email could not be sent.`
    return { ok: false, code: 'account_missing', message, entry: markFailed(deps.db, entry.id, message) }
  }
  return account
}

async function deliver(deps: ResolvedDeps, entry: EmailSendLogEntry): Promise<EmailApprovalResult> {
  const loaded = loadAccount(deps, entry)
  if ('ok' in loaded) return loaded
  const account = loaded

  const attachments = toOutgoingAttachments(entry)

  try {
    const result = await deps.client.sendMessage(toClientAccount(account), {
      to: entry.to,
      cc: entry.cc,
      bcc: entry.bcc,
      subject: entry.subject,
      text: entry.bodyText,
      ...(entry.bodyHtml ? { html: entry.bodyHtml } : {}),
      ...(entry.inReplyTo ? { inReplyTo: entry.inReplyTo } : {}),
      ...(entry.references.length > 0 ? { references: entry.references } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      appendToSentFolder: account.appendToSentFolder,
    })

    const now = new Date().toISOString()
    deps.db.prepare(
      'UPDATE email_send_log SET status = ?, message_id = ?, error_message = NULL, sent_at = ?, updated_at = ? WHERE id = ?',
    ).run('sent', result.messageId, now, now, entry.id)

    return { ok: true, entry: getEmailSendLogEntry(deps.db, entry.id)! }
  } catch (err) {
    const message = errorText(err)
    return {
      ok: false,
      code: 'send_failed',
      message: `Failed to send email: ${message}`,
      entry: markFailed(deps.db, entry.id, message),
    }
  }
}

export interface EmailApprovalService {
  approve: (id: string, decider: EmailApprovalDecider) => Promise<EmailApprovalResult>
  reject: (id: string, decider: EmailApprovalDecider) => Promise<EmailApprovalResult>
  retry: (id: string, decider: EmailApprovalDecider) => Promise<EmailApprovalResult>
}

export function createEmailApprovalService(deps: EmailApprovalDeps): EmailApprovalService {
  const resolved = resolveDeps(deps)
  recoverStuckApprovedEmails(resolved.db)

  function missing(id: string): EmailApprovalResult {
    return { ok: false, code: 'not_found', message: `Send log entry not found: ${id}`, entry: null }
  }

  return {
    async approve(id, decider) {
      const current = getEmailSendLogEntry(resolved.db, id)
      if (!current) return missing(id)

      const approved = transition(resolved.db, id, ['pending'], 'approved', decider)
      if (!approved) {
        const latest = getEmailSendLogEntry(resolved.db, id)!
        return { ok: false, code: 'already_decided', message: decidedLabel(latest), entry: latest }
      }

      // Notify only once the send is done: channels that did not click (other
      // browser tabs, Telegram) would otherwise be told "approved" and never
      // hear about a subsequent SMTP failure.
      const result = await deliver(resolved, approved)
      await notifyEmailApprovalResolved(result.entry ?? approved)
      return result
    },

    async reject(id, decider) {
      const current = getEmailSendLogEntry(resolved.db, id)
      if (!current) return missing(id)

      const rejected = transition(resolved.db, id, ['pending'], 'rejected', decider)
      if (!rejected) {
        const latest = getEmailSendLogEntry(resolved.db, id)!
        return { ok: false, code: 'already_decided', message: decidedLabel(latest), entry: latest }
      }

      await notifyEmailApprovalResolved(rejected)
      return { ok: true, entry: rejected }
    },

    async retry(id, decider) {
      const current = getEmailSendLogEntry(resolved.db, id)
      if (!current) return missing(id)

      const retrying = transition(resolved.db, id, ['failed'], 'approved', decider)
      if (!retrying) {
        const latest = getEmailSendLogEntry(resolved.db, id)!
        return {
          ok: false,
          code: 'not_retryable',
          message: `Only failed emails can be retried (status: ${latest.status}).`,
          entry: latest,
        }
      }

      return deliver(resolved, retrying)
    },
  }
}
