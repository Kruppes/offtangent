/**
 * tool-output-spill.ts: keep a long tool output out of the prompt, but not
 * out of reach.
 *
 * A tool result enters the transcript once and is then re-sent with every
 * following request of the run; a long one also pushes the context towards
 * the next compaction trim, and every trim re-sends the whole window
 * uncached. Cutting the output BEFORE it is sent the first time costs no
 * cache at all. Measured on this installation (tool_calls, 2026-09-03 to
 * 2026-10-03, 67.482 shell calls): p50 717, p90 5.190, p95 8.396, p99 19.667
 * characters; 5,4 % of the calls were longer than 8.000 characters and
 * carried 19 % of all shell result characters beyond that mark.
 *
 * Above the threshold the model gets head + tail, the full output goes to a
 * file under `<DATA_DIR>/tool-output/` and the marker names the file, its
 * length and the read_file offset that continues after the head.
 *
 * Rules:
 *  - the file name is generated here (tool label + time + random), never
 *    derived from input, so a command cannot steer where it lands;
 *  - directory 0700, file 0600, never overwritten (`wx`);
 *  - the caller passes text that is ALREADY sealed by the secret boundary:
 *    this module writes what it gets and never sees plaintext secrets;
 *  - files older than {@link TOOL_OUTPUT_SPILL_TTL_MS} are removed
 *    opportunistically (at most every few minutes, on the next spill);
 *  - any file system error returns null, the caller falls back to the plain
 *    head + tail cap, so a full disk never fails a tool call.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import nodePath from 'node:path'
import { getDataDir } from './uploads.js'

export const TOOL_OUTPUT_SPILL_DIRNAME = 'tool-output'
/** Spilled outputs are kept for a day: long enough for a task, short enough not to pile up. */
export const TOOL_OUTPUT_SPILL_TTL_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const FILE_NAME_RE = /^[a-z0-9_-]+-\d+-[0-9a-f]{16}\.txt$/

let lastCleanupAt = 0

/** Directory of spilled tool outputs (inside DATA_DIR, never the workspace). */
export function getToolOutputSpillDir(): string {
  return nodePath.join(getDataDir(), TOOL_OUTPUT_SPILL_DIRNAME)
}

export interface SpilledOutput {
  /** Head + marker + tail, ready for the tool result. */
  text: string
  /** Absolute path of the file with the complete output. */
  path: string
  /** Length of the complete output in characters. */
  totalChars: number
  /** Characters of the head shown; read_file(path, offset=headChars) continues there. */
  headChars: number
}

export interface SpillOptions {
  /** Characters of the output shown inline (head + tail). */
  maxChars: number
  /** Short tool label for the file name and the marker, e.g. `shell`. */
  label: string
  /** Extra marker facts, e.g. `exit code 1`. */
  note?: string
  /** Clock for tests. */
  now?: number
}

/**
 * Save `text` (already sealed) to a new file and return head + tail with a
 * marker. Returns null when nothing has to be cut or the file could not be
 * written.
 */
export function spillToolOutput(text: string, options: SpillOptions): SpilledOutput | null {
  const { maxChars } = options
  const totalChars = text.length
  if (!Number.isFinite(maxChars) || maxChars <= 0 || totalChars <= maxChars) return null
  const now = options.now ?? Date.now()
  const label = options.label.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'tool'
  let filePath: string
  try {
    const dir = getToolOutputSpillDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    maybeCleanup(dir, now)
    filePath = nodePath.join(dir, `${label}-${now}-${crypto.randomBytes(8).toString('hex')}.txt`)
    fs.writeFileSync(filePath, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    fs.chmodSync(filePath, 0o600)
  } catch (err) {
    console.error('[tool-output] Could not save a long tool output, falling back to the plain cap:', err)
    return null
  }
  const headChars = Math.floor(maxChars / 2)
  const tailChars = maxChars - headChars
  const omitted = totalChars - headChars - tailChars
  const note = options.note ? `, ${options.note}` : ''
  const marker =
    `\n\n…[${label} output truncated: ${totalChars} characters total${note}, ${omitted} omitted here. ` +
    `Shown: the first ${headChars} and the last ${tailChars} characters. ` +
    `Complete output saved to ${filePath} (kept for 24 h); read_file on it with offset ${headChars} ` +
    `continues after the head.]…\n\n`
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(totalChars - tailChars)}`,
    path: filePath,
    totalChars,
    headChars,
  }
}

function maybeCleanup(dir: string, now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
  lastCleanupAt = now
  cleanupToolOutputSpills({ dir, now })
}

/**
 * Remove spilled outputs older than `maxAgeMs`. Only touches files whose name
 * this module generates. Returns the number of removed files.
 */
export function cleanupToolOutputSpills(options: { dir?: string; now?: number; maxAgeMs?: number } = {}): number {
  const dir = options.dir ?? getToolOutputSpillDir()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? TOOL_OUTPUT_SPILL_TTL_MS
  let removed = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!FILE_NAME_RE.test(name)) continue
    const file = nodePath.join(dir, name)
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile()) continue
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file)
        removed++
      }
    } catch {
      /* raced with another cleanup */
    }
  }
  return removed
}

/** Test hook: let the next spill run the cleanup again. */
export function resetToolOutputSpillCleanupForTests(): void {
  lastCleanupAt = 0
}
