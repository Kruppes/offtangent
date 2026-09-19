import type { EmailSendLogEntry, EmailSendLogStatus } from '~/api/email'
import { parseBackendTimestamp } from '~/utils/datetime'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'muted'

const STATUS_VARIANTS: Record<EmailSendLogStatus, BadgeVariant> = {
  sent: 'success',
  approved: 'success',
  pending: 'warning',
  rejected: 'destructive',
  blocked: 'destructive',
  failed: 'destructive',
}

export function statusVariant(status?: EmailSendLogStatus): BadgeVariant {
  return status ? STATUS_VARIANTS[status] : 'muted'
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
