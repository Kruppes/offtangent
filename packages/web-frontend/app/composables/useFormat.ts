import { parseBackendTimestamp } from '~/utils/datetime'

/**
 * Shared formatting utilities.
 *
 * Centralises Intl-based formatters so every page uses the same output
 * without duplicating the logic. Backend timestamps are parsed via
 * `parseBackendTimestamp` so naked SQLite UTC strings render in the user's
 * local timezone rather than being misread as local time.
 *
 * Formatting follows the user's browser/OS regional settings (the `undefined`
 * locale), intentionally decoupled from the i18n UI language: the displayed
 * language and the number/date/time format are separate concerns.
 */
export function useFormat() {
  /** Browser-locale number: 1,234,567 */
  function formatNumber(value: number): string {
    return new Intl.NumberFormat(undefined).format(value)
  }

  /** Browser-locale currency (USD): $1,234.56 */
  function formatCurrency(value: number): string {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(value)
  }

  /** Medium date + short time: "Mar 28, 2026, 2:30 PM" */
  function formatDateTime(value: string): string {
    const date = parseBackendTimestamp(value)
    if (!date) return ''
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  }

  /** Medium date only: "Mar 28, 2026" */
  function formatDate(value: string): string {
    const date = parseBackendTimestamp(value)
    if (!date) return ''
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
    }).format(date)
  }

  /** Time only: "14:30:05" */
  function formatTime(value: string | undefined): string {
    const date = parseBackendTimestamp(value)
    if (!date) return value ?? ''
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  /** Short time without seconds: "14:30" */
  function formatTimeShort(value: string): string {
    const date = parseBackendTimestamp(value)
    if (!date) return ''
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  /** Compact timestamp for log rows: "Mar 28, 14:30:05" */
  function formatTimestamp(ts: string): string {
    const date = parseBackendTimestamp(ts)
    if (!date) return ''
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  /** Human-friendly duration: "120ms" or "1.2s" */
  function formatDuration(ms: number | null | undefined): string {
    if (ms == null) return '—'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  return {
    formatNumber,
    formatCurrency,
    formatDateTime,
    formatDate,
    formatTime,
    formatTimeShort,
    formatTimestamp,
    formatDuration,
  }
}
