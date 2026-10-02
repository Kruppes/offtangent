import type { LogEntry } from '~/composables/useLogs'

/**
 * Visual mapping helpers for log entries.
 *
 * Determines badge colours, icon names, display names, and source labels
 * based on the log entry's tool name, session ID, and input data.
 */
export function useLogDisplay() {
  const { t } = useI18n()
  const { isSkillLoad, getSkillName, extractSkillContent } = useSkillDetection()

  /** Whether this entry represents a SKILL.md load */
  function isEntrySkillLoad(entry: LogEntry): boolean {
    return isSkillLoad(entry.toolName, entry.input)
  }

  /** User-facing tool name (replaces read_file with "Load Skill" when applicable) */
  function entryDisplayName(entry: LogEntry): string {
    return isEntrySkillLoad(entry) ? 'Load Skill' : entry.toolName
  }

  /**
   * Whether the entry originates from a background (task) sub-session.
   *
   * Uses the joined `sessionType` metadata from the backend instead of
   * parsing the session_id string (session IDs are UUIDs after PRD #11).
   */
  function isTaskSession(entryOrType: LogEntry | string | null | undefined): boolean {
    if (!entryOrType) return false
    const type = typeof entryOrType === 'string' ? entryOrType : entryOrType.sessionType
    if (!type) return false
    return type === 'task' || type === 'heartbeat' || type === 'consolidation' || type === 'loop_detection'
  }

  /** Translated source label for the session badge */
  function getSourceLabel(entryOrType: LogEntry | string | null | undefined): string {
    return isTaskSession(entryOrType) ? t('logs.sourceTask') : t('logs.sourceMainAgent')
  }

  /** Tailwind classes for the tool badge */
  function toolBadgeClass(name: string): string {
    if (!name) return 'border-transparent bg-primary/15 text-primary'
    const lower = name.toLowerCase()
    if (lower === 'load skill')
      return 'border-transparent bg-tertiary/15 text-tertiary'
    if (lower === 'session_start')
      return 'border-transparent bg-success/15 text-success'
    if (lower === 'session_end')
      return 'border-transparent bg-primary/15 text-primary'
    if (lower === 'session_timeout')
      return 'border-transparent bg-warning/15 text-warning'
    if (lower === 'memory_consolidation')
      return 'border-transparent bg-tertiary/15 text-tertiary'
    if (lower.includes('bash') || lower.includes('exec') || lower.includes('command'))
      return 'border-transparent bg-warning/15 text-warning'
    if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit'))
      return 'border-transparent bg-primary/15 text-primary'
    if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate'))
      return 'border-transparent bg-tertiary/15 text-tertiary'
    return 'border-transparent bg-primary/15 text-primary'
  }

  /** Icon name for the tool badge */
  function toolIcon(name: string): string {
    if (!name) return 'wrench'
    const lower = name.toLowerCase()
    if (lower === 'load skill') return 'puzzle'
    if (lower === 'session_start') return 'sparkles'
    if (lower === 'session_end' || lower === 'session_timeout') return 'clock'
    if (lower === 'memory_consolidation') return 'brain'
    if (lower.includes('bash') || lower.includes('exec') || lower.includes('command')) return 'activity'
    if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit')) return 'file'
    if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate')) return 'brain'
    return 'wrench'
  }

  return {
    isEntrySkillLoad,
    entryDisplayName,
    isTaskSession,
    getSourceLabel,
    toolBadgeClass,
    toolIcon,
    getSkillName,
    extractSkillContent,
  }
}
