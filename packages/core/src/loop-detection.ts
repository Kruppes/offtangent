import { createHash } from 'node:crypto'

/**
 * Represents a tracked tool call for loop detection
 */
export interface TrackedToolCall {
  toolName: string
  argsHash: string
  outputHash: string
  isError: boolean
  timestamp: number
}

/**
 * Configuration for loop detection
 */
export interface LoopDetectionConfig {
  enabled: boolean
  method: 'systematic' | 'smart' | 'auto'
  maxConsecutiveFailures: number
  smartProvider?: string
  /** How often (in tool calls) to run LLM-based detection */
  smartCheckInterval?: number
}

/**
 * Result of a loop detection check
 */
export interface LoopDetectionResult {
  loopDetected: boolean
  method: 'systematic' | 'smart'
  details: string
}

/**
 * Hash a value deterministically for comparison
 */
function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Tracker for a single task's tool calls, used for systematic loop detection.
 */
export class ToolCallTracker {
  private history: TrackedToolCall[] = []
  private maxHistory: number

  constructor(maxHistory: number = 50) {
    this.maxHistory = maxHistory
  }

  /**
   * Record a tool call
   */
  record(toolName: string, args: unknown, output: string, isError: boolean): void {
    const argsHash = hashValue(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
    const outputHash = hashValue(output)

    this.history.push({
      toolName,
      argsHash,
      outputHash,
      isError,
      timestamp: Date.now(),
    })

    // Trim history to max size
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
  }

  /**
   * Get the full history (for LLM-based detection)
   */
  getHistory(): readonly TrackedToolCall[] {
    return this.history
  }

  /**
   * Get the total number of recorded tool calls
   */
  getCount(): number {
    return this.history.length
  }

  /**
   * Check for systematic loop: same tool+args producing same error output
   * N consecutive times.
   */
  checkSystematicLoop(maxConsecutiveFailures: number): LoopDetectionResult {
    if (this.history.length < maxConsecutiveFailures) {
      return { loopDetected: false, method: 'systematic', details: '' }
    }

    // Look at the last N entries
    const recent = this.history.slice(-maxConsecutiveFailures)

    // All must be errors
    if (!recent.every(tc => tc.isError)) {
      return { loopDetected: false, method: 'systematic', details: '' }
    }

    // All must have the same tool name, args hash, and output hash
    const first = recent[0]
    const allSame = recent.every(
      tc =>
        tc.toolName === first.toolName &&
        tc.argsHash === first.argsHash &&
        tc.outputHash === first.outputHash,
    )

    if (allSame) {
      return {
        loopDetected: true,
        method: 'systematic',
        details: `Tool "${first.toolName}" produced the same error ${maxConsecutiveFailures} consecutive times`,
      }
    }

    return { loopDetected: false, method: 'systematic', details: '' }
  }
}

/**
 * Build the prompt for LLM-based loop detection
 */
export function buildSmartDetectionPrompt(history: readonly TrackedToolCall[]): string {
  const recentCalls = history.slice(-10).map((tc, i) => {
    const status = tc.isError ? 'ERROR' : 'OK'
    return `${i + 1}. [${status}] ${tc.toolName} (args: ${tc.argsHash}) → output: ${tc.outputHash}`
  })

  return `Analyze these recent tool calls from an AI agent working on a task.
Is this agent making progress or stuck in a loop?

Recent tool calls:
${recentCalls.join('\n')}

Respond with exactly one word: PROGRESS or LOOP`
}

/**
 * Parse the LLM response for smart detection
 */
export function parseSmartDetectionResponse(response: string): LoopDetectionResult {
  const normalized = response.trim().toUpperCase()

  if (normalized.includes('LOOP')) {
    return {
      loopDetected: true,
      method: 'smart',
      details: 'LLM-based detection determined the agent is stuck in a loop',
    }
  }

  return {
    loopDetected: false,
    method: 'smart',
    details: '',
  }
}

/**
 * Determine which detection method to use in auto mode
 */
export function resolveDetectionMethod(
  config: LoopDetectionConfig,
  toolCallCount: number,
): 'systematic' | 'smart' | 'none' {
  if (!config.enabled) return 'none'

  switch (config.method) {
    case 'systematic':
      return 'systematic'
    case 'smart':
      return config.smartProvider ? 'smart' : 'systematic'
    case 'auto':
      // In auto mode: use systematic by default,
      // switch to smart if provider configured and task has enough tool calls
      if (config.smartProvider && toolCallCount > 10) {
        return 'smart'
      }
      return 'systematic'
    default:
      return 'systematic'
  }
}

/**
 * Format a status update message for periodic injection into main agent
 */
export function formatPeriodicStatusUpdate(
  taskId: string,
  taskName: string,
  runtimeMinutes: number,
  toolCallCount: number,
  totalTokens: number,
): string {
  return `<task_status task_id="${taskId}" type="periodic_update">Background task #${taskId.slice(0, 8)} "${taskName}" running for ${runtimeMinutes} min (${toolCallCount} tool calls, ~${totalTokens} tokens). /kill_task ${taskId} to stop.</task_status>`
}
