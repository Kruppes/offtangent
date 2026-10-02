import type { ChatMessage } from '../../composables/useChat'

export interface TranscriptRow {
  message: ChatMessage
  index: number
  key: string
  /**
   * The steps of one assistant turn (tool calls and reasoning blocks), shown
   * as ONE collapsed turn line. Set only on the row that stands for them.
   */
  steps?: ChatMessage[]
  /**
   * Timestamp of the last finished assistant answer of the same turn, the
   * best available end of the turn when the steps carry no completion time.
   */
  turnEnd?: string
}

/** A tool call or a reasoning block: the work of a turn, not its answer. */
export function isTurnStep(message: ChatMessage): boolean {
  return (message.role === 'tool' && !!message.toolData) || (message.role === 'assistant' && !!message.isThinking)
}

/** Only the user (or a session divider) starts a new turn. */
function startsTurn(message: ChatMessage): boolean {
  return message.role === 'user' || message.role === 'divider'
}

/**
 * Presentation only: every step of a turn (all tool calls and reasoning
 * blocks between two user messages) folds into ONE row at the position of
 * the first step, so the answer text stands directly below one turn line.
 * Every other message keeps its identity, index and relative order, which the
 * picker/action dispatch relies on. Inputs are never mutated.
 */
export function groupTranscript(messages: readonly ChatMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let turnSteps: TranscriptRow | null = null
  messages.forEach((message, index) => {
    if (startsTurn(message)) turnSteps = null
    if (isTurnStep(message)) {
      if (turnSteps) {
        turnSteps.steps!.push(message)
        return
      }
      turnSteps = { message, index, key: `steps:${String(message.id ?? `${message.role}:${index}`)}`, steps: [message] }
      rows.push(turnSteps)
      return
    }
    if (turnSteps && message.role === 'assistant' && !message.streaming && message.timestamp) turnSteps.turnEnd = message.timestamp
    rows.push({ message, index, key: String(message.id ?? `${message.role}:${index}`) })
  })
  return rows
}

export interface TurnSummary {
  /** Tool calls of the turn ("12 steps"). */
  toolCount: number
  thinkingCount: number
  errorCount: number
  /** True while a step of this turn is still running (live status line). */
  live: boolean
  /** 1-based number of the step that is running now, when live. */
  currentStep: number | null
  /** The running step: a tool (by name) or reasoning. */
  current: { kind: 'tool'; message: ChatMessage } | { kind: 'thinking' } | null
  /** Whole seconds from the first step to the last known end; null when not derivable. */
  durationSeconds: number | null
}

function time(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * What the collapsed turn line says. Pure: the caller passes `now` and
 * whether the conversation still has a turn in flight.
 */
export function summarizeTurn(steps: readonly ChatMessage[], options: { active: boolean; now: number; turnEnd?: string }): TurnSummary {
  const tools = steps.filter(step => step.role === 'tool')
  const states = tools.map(step => toolState(step, options.active))
  const runningIndex = states.lastIndexOf('running')
  const last = steps[steps.length - 1]
  const thinkingLive = options.active && !!last?.isThinking && !!last.streaming
  const live = runningIndex >= 0 || thinkingLive
  let current: TurnSummary['current'] = null
  if (thinkingLive) current = { kind: 'thinking' }
  else if (runningIndex >= 0) current = { kind: 'tool', message: tools[runningIndex]! }

  const start = time(steps[0]?.timestamp)
  let end: number | null = null
  if (live) end = options.now
  else {
    for (const step of steps) {
      const candidate = time(step.toolData?.completedAt) ?? time(step.timestamp)
      if (candidate !== null && (end === null || candidate > end)) end = candidate
    }
    const answer = time(options.turnEnd)
    if (answer !== null && (end === null || answer > end)) end = answer
  }
  const durationSeconds = start !== null && end !== null && end > start ? Math.floor((end - start) / 1000) : (live && start !== null ? 0 : null)

  return {
    toolCount: tools.length,
    thinkingCount: steps.length - tools.length,
    errorCount: states.filter(state => state === 'error').length,
    live,
    currentStep: live ? (thinkingLive ? tools.length + 1 : runningIndex + 1) : null,
    current,
    durationSeconds,
  }
}

/** "40 s", "2 min 5 s", "1 h 3 min": short, never fractional. */
export function formatTurnDuration(seconds: number): { key: 'seconds' | 'minutes' | 'hours'; params: Record<string, number> } {
  if (seconds < 60) return { key: 'seconds', params: { s: seconds } }
  if (seconds < 3600) return { key: 'minutes', params: { m: Math.floor(seconds / 60), s: seconds % 60 } }
  return { key: 'hours', params: { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) } }
}

export function transcriptState(error: boolean, loading: boolean, count: number) {
  return error ? 'error' : loading ? 'loading' : count === 0 ? 'empty' : 'ready'
}

export function toolState(message: ChatMessage, active = true): 'running' | 'complete' | 'error' | 'unknown' {
  if (message.toolData?.toolIsError) return 'error'
  if (message.toolData?.toolResult !== undefined || message.toolData?.toolIsError === false) return 'complete'
  // Persisted rows without a result are not evidence of a still-running call.
  return active && message.id === undefined ? 'running' : 'unknown'
}

export function elapsedToolSeconds(message: ChatMessage, now: number): number | null {
  if (!message.timestamp) return null
  const end = message.toolData?.completedAt ? Date.parse(message.toolData.completedAt) : now
  if (toolState(message) !== 'running' && !message.toolData?.completedAt) return null
  const start = Date.parse(message.timestamp)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : null
}
