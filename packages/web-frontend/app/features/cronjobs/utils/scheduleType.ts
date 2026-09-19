export type CronjobScheduleType = 'recurring' | 'fixedDate'

const FIXED_FIELD = /^\d+(,\d+)*$/

/**
 * A cron with a fixed day-of-month and month only fires on specific calendar
 * dates (once per year at most), which in practice is used for one-off jobs.
 */
export function getCronjobScheduleType(schedule: string): CronjobScheduleType {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length < 5) return 'recurring'

  const [dayOfMonth, month] = fields.slice(-3, -1)
  return FIXED_FIELD.test(dayOfMonth ?? '') && FIXED_FIELD.test(month ?? '')
    ? 'fixedDate'
    : 'recurring'
}
