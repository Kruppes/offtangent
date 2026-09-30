import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'

/**
 * Audit trail of every send attempt the agent makes — including allowlist hits.
 * Stores the full message so a pending entry can be sent later by the backend
 * without involving the agent again.
 */

/**
 * `sending` is written BEFORE the SMTP handover: a crash or timeout between
 * handover and log write would otherwise leave no trace, and the agent would
 * send the same mail a second time (duplicate-send hotfix, 2026-09-26).
 */
export type EmailSendLogStatus = 'sent' | 'sending' | 'pending' | 'approved' | 'rejected' | 'blocked' | 'failed'

export const EMAIL_SEND_LOG_STATUSES: EmailSendLogStatus[] = [
  'sent',
  'sending',
  'pending',
  'approved',
  'rejected',
  'blocked',
  'failed',
]

export interface EmailSendLogAttachment {
  filename: string
  path?: string
  size: number
  contentType?: string
}

export interface EmailSendLogEntry {
  id: string
  accountId: string
  accountName: string
  status: EmailSendLogStatus
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyText: string
  bodyHtml: string | null
  attachments: EmailSendLogAttachment[]
  inReplyTo: string | null
  references: string[]
  reason: string | null
  errorMessage: string | null
  messageId: string | null
  sessionId: string | null
  decidedBy: string | null
  decidedAt: string | null
  sentAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateEmailSendLogInput {
  accountId: string
  accountName: string
  status: EmailSendLogStatus
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string | null
  attachments?: EmailSendLogAttachment[]
  inReplyTo?: string | null
  references?: string[]
  reason?: string | null
  errorMessage?: string | null
  messageId?: string | null
  sessionId?: string | null
  sentAt?: string | null
}

export interface UpdateEmailSendLogInput {
  status?: EmailSendLogStatus
  reason?: string | null
  errorMessage?: string | null
  messageId?: string | null
  decidedBy?: string | null
  decidedAt?: string | null
  sentAt?: string | null
}

export interface ListEmailSendLogOptions {
  accountId?: string
  status?: EmailSendLogStatus | EmailSendLogStatus[]
  recipient?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

interface EmailSendLogRow {
  id: string
  account_id: string
  account_name: string
  status: string
  recipients_to: string
  recipients_cc: string
  recipients_bcc: string
  subject: string
  body_text: string
  body_html: string | null
  attachments: string
  in_reply_to: string | null
  references_header: string
  reason: string | null
  error_message: string | null
  message_id: string | null
  session_id: string | null
  decided_by: string | null
  decided_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

/**
 * How long a `sending` entry may stay that way before it counts as an
 * interrupted attempt. A real SMTP handover takes seconds; 15 minutes is far
 * beyond that and still short enough to be useful right after a restart.
 */
export const EMAIL_SENDING_STALE_MS = 15 * 60 * 1000

/** Reason written on a stale `sending` entry. Deliberately explicit. */
export const EMAIL_SENDING_UNKNOWN_REASON =
  'Ergebnis unbekannt (Abbruch während des Versands), Empfänger prüfen, nicht blind erneut senden'

/** What the agent is told when the outcome after the SMTP handover is unknown. */
export const EMAIL_SEND_UNKNOWN_OUTCOME_MESSAGE =
  'Versand-Ergebnis unbekannt, nicht erneut senden, Send-Log prüfen'

/**
 * Close out `sending` entries no process is working on any more.
 *
 * The status is written BEFORE the SMTP handover, so a crash or a kill during
 * the handover leaves it behind forever. An entry stuck at `sending` is an
 * unanswered question ("did this mail go out?"), and leaving it open invites a
 * duplicate send. It is therefore marked `failed` with a reason that says the
 * outcome is UNKNOWN — never "not sent".
 */
export function failStaleSendingEntries(
  db: Database,
  options: { staleMs?: number; now?: () => number } = {},
): number {
  const staleMs = options.staleMs ?? EMAIL_SENDING_STALE_MS
  const now = options.now ?? (() => Date.now())
  const cutoff = new Date(now() - staleMs).toISOString().replace('T', ' ').slice(0, 19)
  const result = db
    .prepare(`
      UPDATE email_send_log
         SET status = 'failed',
             reason = ?,
             error_message = COALESCE(error_message, ?),
             updated_at = datetime('now')
       WHERE status = 'sending'
         AND COALESCE(updated_at, created_at) <= ?
    `)
    .run(EMAIL_SENDING_UNKNOWN_REASON, EMAIL_SENDING_UNKNOWN_REASON, cutoff)
  const changed = Number(result.changes ?? 0)
  if (changed > 0) {
    console.warn(`[axiom] ${changed} email send log entries stuck in "sending" marked as failed (outcome unknown)`)
  }
  return changed
}

export function initEmailSendLogTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_send_log (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'sending', 'pending', 'approved', 'rejected', 'blocked', 'failed')),
      recipients_to TEXT NOT NULL DEFAULT '[]',
      recipients_cc TEXT NOT NULL DEFAULT '[]',
      recipients_bcc TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      in_reply_to TEXT,
      references_header TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      error_message TEXT,
      message_id TEXT,
      session_id TEXT,
      decided_by TEXT,
      decided_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_email_send_log_account ON email_send_log(account_id);
    CREATE INDEX IF NOT EXISTS idx_email_send_log_status ON email_send_log(status);
    CREATE INDEX IF NOT EXISTS idx_email_send_log_created_at ON email_send_log(created_at);
  `)

  // Migration: add 'sending' to the status CHECK constraint. Decide from the
  // stored schema, not from a failing probe insert: a busy or locked database
  // must never be mistaken for an old table and trigger a rebuild.
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_send_log'")
    .get() as { sql?: string } | undefined
  if (schema?.sql && !schema.sql.includes("'sending'")) {
    // One transaction: a crash mid-rebuild must not leave the log renamed away.
    db.transaction(() => {
    db.exec(`
      ALTER TABLE email_send_log RENAME TO email_send_log_old;
      CREATE TABLE email_send_log (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent', 'sending', 'pending', 'approved', 'rejected', 'blocked', 'failed')),
        recipients_to TEXT NOT NULL DEFAULT '[]',
        recipients_cc TEXT NOT NULL DEFAULT '[]',
        recipients_bcc TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        body_html TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        in_reply_to TEXT,
        references_header TEXT NOT NULL DEFAULT '[]',
        reason TEXT,
        error_message TEXT,
        message_id TEXT,
        session_id TEXT,
        decided_by TEXT,
        decided_at TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO email_send_log SELECT * FROM email_send_log_old;
      DROP TABLE email_send_log_old;
      CREATE INDEX IF NOT EXISTS idx_email_send_log_account ON email_send_log(account_id);
      CREATE INDEX IF NOT EXISTS idx_email_send_log_status ON email_send_log(status);
      CREATE INDEX IF NOT EXISTS idx_email_send_log_created_at ON email_send_log(created_at);
    `)
    })()
  }

  // Startup recovery (review M4): whatever was `sending` when the process died
  // has no owner any more.
  failStaleSendingEntries(db)
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToEntry(row: EmailSendLogRow): EmailSendLogEntry {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    status: row.status as EmailSendLogStatus,
    to: parseJsonArray<string>(row.recipients_to),
    cc: parseJsonArray<string>(row.recipients_cc),
    bcc: parseJsonArray<string>(row.recipients_bcc),
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments: parseJsonArray<EmailSendLogAttachment>(row.attachments),
    inReplyTo: row.in_reply_to,
    references: parseJsonArray<string>(row.references_header),
    reason: row.reason,
    errorMessage: row.error_message,
    messageId: row.message_id,
    sessionId: row.session_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createEmailSendLogEntry(db: Database, input: CreateEmailSendLogInput): EmailSendLogEntry {
  const id = randomUUID()
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO email_send_log (
      id, account_id, account_name, status,
      recipients_to, recipients_cc, recipients_bcc,
      subject, body_text, body_html, attachments,
      in_reply_to, references_header, reason, error_message,
      message_id, session_id, sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    input.accountName,
    input.status,
    JSON.stringify(input.to ?? []),
    JSON.stringify(input.cc ?? []),
    JSON.stringify(input.bcc ?? []),
    input.subject,
    input.bodyText,
    input.bodyHtml ?? null,
    JSON.stringify(input.attachments ?? []),
    input.inReplyTo ?? null,
    JSON.stringify(input.references ?? []),
    input.reason ?? null,
    input.errorMessage ?? null,
    input.messageId ?? null,
    input.sessionId ?? null,
    input.sentAt ?? (input.status === 'sent' ? now : null),
    now,
    now,
  )

  return getEmailSendLogEntry(db, id)!
}

export function getEmailSendLogEntry(db: Database, id: string): EmailSendLogEntry | null {
  const row = db.prepare('SELECT * FROM email_send_log WHERE id = ?').get(id) as EmailSendLogRow | undefined
  return row ? rowToEntry(row) : null
}

export function updateEmailSendLogEntry(
  db: Database,
  id: string,
  input: UpdateEmailSendLogInput,
): EmailSendLogEntry | null {
  const columns: Record<keyof UpdateEmailSendLogInput, string> = {
    status: 'status',
    reason: 'reason',
    errorMessage: 'error_message',
    messageId: 'message_id',
    decidedBy: 'decided_by',
    decidedAt: 'decided_at',
    sentAt: 'sent_at',
  }

  const assignments: string[] = []
  const params: unknown[] = []
  for (const [key, column] of Object.entries(columns) as [keyof UpdateEmailSendLogInput, string][]) {
    if (input[key] !== undefined) {
      assignments.push(`${column} = ?`)
      params.push(input[key])
    }
  }

  if (assignments.length === 0) return getEmailSendLogEntry(db, id)

  assignments.push('updated_at = ?')
  params.push(new Date().toISOString(), id)

  db.prepare(`UPDATE email_send_log SET ${assignments.join(', ')} WHERE id = ?`).run(...params)
  return getEmailSendLogEntry(db, id)
}

function buildFilters(options: ListEmailSendLogOptions): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (options.accountId) {
    conditions.push('account_id = ?')
    params.push(options.accountId)
  }

  const statuses = options.status === undefined
    ? []
    : Array.isArray(options.status) ? options.status : [options.status]
  if (statuses.length > 0) {
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }

  if (options.recipient?.trim()) {
    const needle = `%${options.recipient.trim().toLowerCase()}%`
    conditions.push('(lower(recipients_to) LIKE ? OR lower(recipients_cc) LIKE ? OR lower(recipients_bcc) LIKE ?)')
    params.push(needle, needle, needle)
  }

  if (options.search?.trim()) {
    const needle = `%${options.search.trim().toLowerCase()}%`
    conditions.push('(lower(subject) LIKE ? OR lower(body_text) LIKE ?)')
    params.push(needle, needle)
  }

  if (options.dateFrom) {
    conditions.push('created_at >= ?')
    params.push(options.dateFrom)
  }

  if (options.dateTo) {
    conditions.push('created_at <= ?')
    params.push(options.dateTo)
  }

  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', params }
}

export function listEmailSendLog(db: Database, options: ListEmailSendLogOptions = {}): EmailSendLogEntry[] {
  const { where, params } = buildFilters(options)
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const offset = Math.max(0, options.offset ?? 0)

  const rows = db.prepare(
    `SELECT * FROM email_send_log${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as EmailSendLogRow[]

  return rows.map(rowToEntry)
}

export function countEmailSendLog(db: Database, options: ListEmailSendLogOptions = {}): number {
  const { where, params } = buildFilters(options)
  const row = db.prepare(`SELECT COUNT(*) AS count FROM email_send_log${where}`).get(...params) as { count: number }
  return row.count
}
