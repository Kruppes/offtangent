import fs from 'node:fs'
import path from 'node:path'
import { getMemoryDir } from './memory.js'

export interface ConsolidationResult {
  /** Whether MEMORY.md was actually updated */
  updated: boolean
  /** The new MEMORY.md content (only if updated) */
  newContent?: string
  /** Number of daily files that were reviewed */
  dailyFilesReviewed: number
  /** Reason if not updated */
  reason?: string
  /** Token usage from the LLM call */
  usage?: {
    input: number
    output: number
  }
  /**
   * Results of the per-persona consolidation runs (scoped persona memory,
   * RC5 multi-persona bleeding 2026-07-24). Only present when scoped memory
   * is enabled and at least one persona had daily content to consolidate.
   */
  personaRuns?: Array<{
    agentId: string
    updated: boolean
    reason?: string
  }>
}

/**
 * Read daily memory files for the last N days.
 * Returns an array of { date, content } sorted oldest-first.
 */
export function readDailyFilesForConsolidation(
  days: number,
  memoryDir?: string,
): Array<{ date: string; content: string }> {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')

  if (!fs.existsSync(dailyDir)) {
    return []
  }

  const now = new Date()
  const results: Array<{ date: string; content: string }> = []

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    const filePath = path.join(dailyDir, `${dateStr}.md`)

    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      // Skip files that are just the header with no real content
      if (content && content !== `# Daily Memory — ${dateStr}`) {
        results.push({ date: dateStr, content })
      }
    }
  }

  return results
}
