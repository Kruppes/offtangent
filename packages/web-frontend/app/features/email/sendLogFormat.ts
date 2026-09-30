import type { EmailSendLogEntry, EmailSendLogStatus } from '~/api/email'
import { parseBackendTimestamp } from '~/utils/datetime'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'muted'

const STATUS_VARIANTS: Record<EmailSendLogStatus, BadgeVariant> = {
  sent: 'success',
  // Written before the SMTP handover; it stays only for the moment of the send.
  sending: 'warning',
  approved: 'success',
  pending: 'warning',
  rejected: 'destructive',
  blocked: 'destructive',
  failed: 'destructive',
}

export function statusVariant(status?: EmailSendLogStatus): BadgeVariant {
  return status ? STATUS_VARIANTS[status] : 'muted'
}

/**
 * A `sending` entry is stale after this long: the status is written before the
 * SMTP handover, so anything older belonged to a process that died mid-send and
 * the real outcome is unknown.
 */
export const SENDING_STALE_MS = 15 * 60 * 1000

/**
 * Is this entry stuck at `sending`? Such a row must not look harmless: nobody
 * knows whether the mail went out, so the operator has to check the mailbox
 * instead of pressing send again.
 */
export function isStaleSending(entry: { status?: EmailSendLogStatus; updatedAt?: string; createdAt?: string }, now = Date.now()): boolean {
  if (entry?.status !== 'sending') return false
  const stamp = parseBackendTimestamp(entry.updatedAt || entry.createdAt || '')
  if (!stamp) return false
  return now - stamp.getTime() > SENDING_STALE_MS
}

/** i18n key describing who decided about an entry, or null while undecided. */
export function decisionLabelKey(entry: EmailSendLogEntry | null): string | null {
  if (!entry?.decidedBy) return null
  return entry.status === 'rejected' ? 'email.sentLog.rejectedBy' : 'email.sentLog.approvedBy'
}

/**
 * Backend timestamps are UTC, often without a zone marker. `new Date(...)`
 * would read the naked form as LOCAL time and show the entry hours off, so the
 * shared parser normalizes it before rendering in the browser's timezone.
 */
export function formatDateTime(value: string): string {
  const date = parseBackendTimestamp(value)
  return date ? date.toLocaleString() : value
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
