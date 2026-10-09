import type { Database } from './database.js'

export type StrandWorkingMode = 'main' | 'auto'

export function isStrandWorkingMode(value: unknown): value is StrandWorkingMode {
  return value === 'main' || value === 'auto'
}

export function readStrandWorkingMode(db: Database, sessionId?: string): StrandWorkingMode {
  if (!sessionId) return 'main'
  const row = db.prepare("SELECT working_mode FROM sessions WHERE id = ? AND type = 'interactive'")
    .get(sessionId) as { working_mode: string } | undefined
  return row?.working_mode === 'auto' ? 'auto' : 'main'
}

export function strandWorkingModePrompt(agentId: string, mode: StrandWorkingMode): string {
  if (agentId !== 'main') return ''
  const common = `You are Main, responsible for this strand's context, decisions, user communication and checking delegated results. Specialist personas are workers, not automatic replacements for the strand orchestrator. Delegate bounded specialist work with create_task's persona argument when useful. Keep trivial answers and clarifying questions inline. A mode or persona change affects future turns only; existing tasks keep their execution identity.`
  const behavior = mode === 'auto'
    ? 'Auto is delegation-first: prefer bounded background tasks for substantive research, coding, operations and specialist execution. Give workers self-contained briefs, retain the context here, and check and integrate their results. Do not delegate every small question or simple check.'
    : 'Main is inline-first: handle ordinary questions, reasoning and short checks in this strand. Delegate only when substantial, long-running or specialist work benefits from a bounded background task.'
  return `\n\n<strand_working_mode mode="${mode}">\n${common}\n${behavior}\n</strand_working_mode>`
}
