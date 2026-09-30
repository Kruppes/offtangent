import { parseBackendTimestamp } from '~/utils/datetime'

/**
 * Board numbers are money from a German-speaking owner's portfolio: the
 * contract fixes de-DE grouping and EUR, independent of the UI language, so a
 * value never changes meaning between a phone and a desktop.
 */
const decimal = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const euroCompact = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

export function formatEur(value: number | null | undefined, compact = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return (compact ? euroCompact : euro).format(value)
}

export function formatSignedEur(value: number | null | undefined, compact = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${formatEur(value, compact)}`
}

export function formatPct(value: number | null | undefined, signed = true): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${signed && value > 0 ? '+' : ''}${decimal.format(value)} %`
}

export function formatNumberDe(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return decimal.format(value)
}

/** `-1` below, `1` above, `0` for flat or unknown — drives the colour classes. */
export function deltaDirection(value: number | null | undefined): -1 | 0 | 1 {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 0
  return value > 0 ? 1 : -1
}

export function deltaClass(value: number | null | undefined): string {
  const direction = deltaDirection(value)
  if (direction === 1) return 'text-emerald-600 dark:text-emerald-400'
  if (direction === -1) return 'text-rose-600 dark:text-rose-400'
  return 'text-muted-foreground'
}

/**
 * i18n key plus count for "updated x ago". Returning the key instead of a
 * sentence keeps the translation in the locale files and the test deterministic.
 */
export function relativeTimeKey(value: string | null | undefined, now: Date = new Date()): { key: string; count: number } {
  const date = parseBackendTimestamp(value)
  if (!date) return { key: 'boards.updatedUnknown', count: 0 }
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000))
  if (seconds < 60) return { key: 'boards.updatedNow', count: 0 }
  if (seconds < 3600) return { key: 'boards.updatedMinutes', count: Math.floor(seconds / 60) }
  if (seconds < 86_400) return { key: 'boards.updatedHours', count: Math.floor(seconds / 3600) }
  return { key: 'boards.updatedDays', count: Math.floor(seconds / 86_400) }
}

/**
 * One-line plain text from a markdown summary: the chooser row is a link, so
 * it cannot nest rendered markdown (and `**bold**` markers would leak into the
 * label). Emphasis, code and link syntax are reduced to their text.
 */
export function plainSummary(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Only http(s) links are rendered as links; anything else stays plain text. */
export function isExternalHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
