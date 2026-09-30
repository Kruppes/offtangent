// Minimal cron expression parser and next-run-time calculator.
//
// Supports standard 5-field cron format: minute hour day-of-month month day-of-week
// Examples:
//   "0 9 * * *"       - Every day at 9:00
//   "star/15 * * * *" - Every 15 minutes (replace star with *)
//   "0 9 * * 1-5"     - Weekdays at 9:00
//   "30 14 1 * *"     - 1st of every month at 14:30
//   "0 0 * * 0"       - Every Sunday at midnight

export interface CronFields {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
}

/**
 * Parse a single cron field into an array of allowed values.
 */
function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const trimmed = part.trim()

    // Handle step: */N or range/N
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/)
    if (stepMatch) {
      const [, rangePart, stepStr] = stepMatch
      const step = parseInt(stepStr, 10)
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step value: ${stepStr}`)

      let rangeMin = min
      let rangeMax = max

      if (rangePart !== '*') {
        const dashMatch = rangePart.match(/^(\d+)-(\d+)$/)
        if (dashMatch) {
          rangeMin = parseInt(dashMatch[1], 10)
          rangeMax = parseInt(dashMatch[2], 10)
        } else {
          rangeMin = parseInt(rangePart, 10)
          rangeMax = max
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        if (i >= min && i <= max) values.add(i)
      }
      continue
    }

    // Handle wildcard
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }

    // Handle range: N-M
    const dashMatch = trimmed.match(/^(\d+)-(\d+)$/)
    if (dashMatch) {
      const start = parseInt(dashMatch[1], 10)
      const end = parseInt(dashMatch[2], 10)
      if (start > end) throw new Error(`Invalid range: ${trimmed}`)
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i)
      }
      continue
    }

    // Handle single number
    const num = parseInt(trimmed, 10)
    if (isNaN(num)) throw new Error(`Invalid cron field value: ${trimmed}`)
    if (num < min || num > max) throw new Error(`Value ${num} out of range [${min}-${max}]`)
    values.add(num)
  }

  if (values.size === 0) throw new Error(`Empty cron field: ${field}`)
  return Array.from(values).sort((a, b) => a - b)
}

/**
 * Parse a 5-field cron expression string.
 * @throws Error if the expression is invalid
 */
export function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}. Format: "minute hour day-of-month month day-of-week"`)
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6), // 0 = Sunday
  }
}

/**
 * Validate a cron expression string.
 * @returns null if valid, error message string if invalid
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCronExpression(expression)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/**
 * Calculate the next run time after `after` for the given cron fields.
 * Iterates forward minute-by-minute from `after` for up to 2 years.
 *
 * @param fields Parsed cron fields
 * @param after Date to search from (exclusive)
 * @returns Next matching Date, or null if none found within 2 years
 */
export function getNextRunTime(fields: CronFields, after: Date = new Date()): Date | null {
  // Start from the next minute
  const next = new Date(after)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  // Cap at 2 years of searching
  const maxDate = new Date(after)
  maxDate.setFullYear(maxDate.getFullYear() + 2)

  while (next <= maxDate) {
    const month = next.getMonth() + 1 // 1-12
    const dayOfMonth = next.getDate()
    const dayOfWeek = next.getDay() // 0 = Sunday
    const hour = next.getHours()
    const minute = next.getMinutes()

    // Check month
    if (!fields.months.includes(month)) {
      // Jump to next month
      next.setMonth(next.getMonth() + 1, 1)
      next.setHours(0, 0, 0, 0)
      continue
    }

    // Check day-of-month and day-of-week
    const domMatch = fields.daysOfMonth.includes(dayOfMonth)
    const dowMatch = fields.daysOfWeek.includes(dayOfWeek)

    // Standard cron: if both dom and dow are restricted (not *), match either.
    // If only one is restricted, match that one only.
    const domIsWild = fields.daysOfMonth.length === 31
    const dowIsWild = fields.daysOfWeek.length === 7

    let dayMatch: boolean
    if (domIsWild && dowIsWild) {
      dayMatch = true
    } else if (domIsWild) {
      dayMatch = dowMatch
    } else if (dowIsWild) {
      dayMatch = domMatch
    } else {
      // Both restricted: match either (standard cron behavior)
      dayMatch = domMatch || dowMatch
    }

    if (!dayMatch) {
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
      continue
    }

    // Check hour
    if (!fields.hours.includes(hour)) {
      // Jump to next matching hour
      const nextHour = fields.hours.find(h => h > hour)
      if (nextHour !== undefined) {
        next.setHours(nextHour, fields.minutes[0], 0, 0)
      } else {
        // No more hours today, go to next day
        next.setDate(next.getDate() + 1)
        next.setHours(0, 0, 0, 0)
      }
      continue
    }

    // Check minute
    if (!fields.minutes.includes(minute)) {
      const nextMinute = fields.minutes.find(m => m > minute)
      if (nextMinute !== undefined) {
        next.setMinutes(nextMinute, 0, 0)
      } else {
        // No more minutes this hour, go to next hour
        next.setHours(next.getHours() + 1, 0, 0, 0)
      }
      continue
    }

    // All fields match
    return new Date(next)
  }

  return null
}

/**
 * Convert a cron expression to a human-readable description.
 */
export function cronToHumanReadable(expression: string): string {
  try {
    const fields = parseCronExpression(expression)
    const parts: string[] = []

    const domIsWild = fields.daysOfMonth.length === 31
    const dowIsWild = fields.daysOfWeek.length === 7
    const monthIsWild = fields.months.length === 12
    const hourIsWild = fields.hours.length === 24
    const minuteIsWild = fields.minutes.length === 60

    // Time description
    if (!hourIsWild && !minuteIsWild) {
      if (fields.hours.length === 1 && fields.minutes.length === 1) {
        parts.push(`At ${pad(fields.hours[0])}:${pad(fields.minutes[0])}`)
      } else {
        parts.push(`At ${fields.hours.map(h => `${pad(h)}:${fields.minutes.map(m => pad(m)).join(',')}`).join(', ')}`)
      }
    } else if (!minuteIsWild && hourIsWild) {
      if (fields.minutes.length === 1 && fields.minutes[0] === 0) {
        parts.push('Every hour')
      } else {
        parts.push(`At minute ${fields.minutes.join(', ')} of every hour`)
      }
    } else if (minuteIsWild && !hourIsWild) {
      parts.push(`Every minute during hour ${fields.hours.join(', ')}`)
    } else {
      // Check for step patterns
      const rawParts = expression.trim().split(/\s+/)
      if (rawParts[0].includes('/')) {
        const step = rawParts[0].split('/')[1]
        parts.push(`Every ${step} minutes`)
      } else {
        parts.push('Every minute')
      }
    }

    // Day-of-week description
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    if (!dowIsWild) {
      const names = fields.daysOfWeek.map(d => dayNames[d])
      parts.push(`on ${names.join(', ')}`)
    }

    // Day-of-month description
    if (!domIsWild) {
      parts.push(`on day ${fields.daysOfMonth.join(', ')}`)
    }

    // Month description
    if (!monthIsWild) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const names = fields.months.map(m => monthNames[m - 1])
      parts.push(`in ${names.join(', ')}`)
    }

    return parts.join(' ') || expression
  } catch {
    return expression
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}
