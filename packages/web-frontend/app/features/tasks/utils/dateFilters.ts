const TASK_DEFAULT_DATE_RANGE_DAYS = 3

export type DateBoundary = 'start' | 'end'

export function formatDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function createDefaultTaskDateRange(to: Date = new Date()) {
  const from = new Date(to)
  from.setDate(to.getDate() - (TASK_DEFAULT_DATE_RANGE_DAYS - 1))

  return {
    createdFrom: formatDateInputValue(from),
    createdTo: formatDateInputValue(to),
  }
}

/**
 * Convert an <input type="date"> value into the UTC instant that represents
 * the selected local-day boundary. The backend stores task timestamps in UTC,
 * so sending date-only values would make it interpret the user's local date as
 * a UTC day and shift the bucket for non-UTC timezones.
 */
export function formatTaskCreatedAtBoundary(value: string, boundary: DateBoundary): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (!match) return trimmed

  const [, yearRaw, monthRaw, dayRaw] = match
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  const localBoundary = boundary === 'start'
    ? new Date(year, month - 1, day, 0, 0, 0)
    : new Date(year, month - 1, day, 23, 59, 59)

  return localBoundary.toISOString()
}

