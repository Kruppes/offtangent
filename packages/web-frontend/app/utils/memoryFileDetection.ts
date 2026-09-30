/**
 * Utility to detect memory-related file operations and provide
 * descriptive labels and icon hints for the chat view.
 */

export interface MemoryFileInfo {
  isMemoryFile: boolean
  label: string
  icon: 'brain' | 'settings'
  /** Memory-root-relative path, minus any folder already implied by the label. */
  displayPath: string | null
}

interface MemoryPathPattern {
  pattern: RegExp
  readLabel: string
  writeLabel: string
  editLabel: string
  /** Folder prefix that the label already conveys and that is dropped from displayPath. */
  folder?: string
}

const MEMORY_PATH_PATTERNS: MemoryPathPattern[] = [
  { pattern: /SOUL\.md$/i, readLabel: 'Reading Personality', writeLabel: 'Writing Personality', editLabel: 'Editing Personality' },
  { pattern: /MEMORY\.md$/i, readLabel: 'Reading Memory', writeLabel: 'Writing Memory', editLabel: 'Editing Memory' },
  { pattern: /AGENTS\.md$/i, readLabel: 'Reading Agent Rules', writeLabel: 'Writing Agent Rules', editLabel: 'Editing Agent Rules' },
  { pattern: /HEARTBEAT\.md$/i, readLabel: 'Reading Heartbeat Tasks', writeLabel: 'Writing Heartbeat Tasks', editLabel: 'Editing Heartbeat Tasks' },
  { pattern: /\/daily\/[^/]+\.md$/i, readLabel: 'Reading Daily Notes', writeLabel: 'Writing Daily Notes', editLabel: 'Editing Daily Notes', folder: 'daily/' },
  { pattern: /\/users\/[^/]+\.md$/i, readLabel: 'Reading User Profile', writeLabel: 'Writing User Profile', editLabel: 'Editing User Profile', folder: 'users/' },
  { pattern: /\/wiki\/.+\.md$/i, readLabel: 'Reading Wiki', writeLabel: 'Writing Wiki', editLabel: 'Editing Wiki', folder: 'wiki/' },
]

/**
 * Check if a tool call path is a memory file and return display info.
 */
export function detectMemoryFile(
  toolName: string,
  toolArgs: unknown,
): MemoryFileInfo {
  const defaultResult: MemoryFileInfo = { isMemoryFile: false, label: '', icon: 'settings', displayPath: null }

  // Only match file read/write/edit tools
  const isRead = toolName === 'read_file' || toolName === 'Read'
  const isWrite = toolName === 'write_file' || toolName === 'Write'
  const isEdit = toolName === 'edit_file' || toolName === 'Edit'
  if (!isRead && !isWrite && !isEdit) return defaultResult

  // Extract path from tool args
  const filePath = extractPath(toolArgs)
  if (!filePath) return defaultResult

  // Check if path is in memory directory
  if (!isMemoryPath(filePath)) return defaultResult

  const relativePath = toMemoryRelativePath(filePath)

  for (const { pattern, readLabel, writeLabel, editLabel, folder } of MEMORY_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        isMemoryFile: true,
        label: isEdit ? editLabel : isWrite ? writeLabel : readLabel,
        icon: 'brain',
        displayPath: folder && relativePath?.startsWith(folder) ? relativePath.slice(folder.length) : relativePath,
      }
    }
  }

  return {
    isMemoryFile: true,
    label: isEdit ? 'Editing Memory File' : isWrite ? 'Writing Memory File' : 'Reading Memory File',
    icon: 'brain',
    displayPath: relativePath,
  }
}

function extractPath(toolArgs: unknown): string | null {
  if (!toolArgs || typeof toolArgs !== 'object') return null
  const args = toolArgs as Record<string, unknown>
  if (typeof args.path === 'string') return args.path
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.filePath === 'string') return args.filePath
  return null
}

// The memory root is `data/memory/` in production and `.data/memory/` in
// local development; both must be recognised.
const MEMORY_ROOT = /(?:^|\/)\.?data\/memory\//

function isMemoryPath(filePath: string): boolean {
  return (
    MEMORY_ROOT.test(filePath) ||
    filePath.includes('/memory/SOUL.md') ||
    filePath.includes('/memory/MEMORY.md') ||
    filePath.includes('/config/AGENTS.md') ||
    filePath.includes('/config/HEARTBEAT.md') ||
    filePath.includes('/config/CONSOLIDATION.md')
  )
}

/**
 * Extract a canonical memory file path for display purposes.
 * Always returns `/data/memory/...` regardless of the actual host path.
 */
export function extractMemoryFileName(toolArgs: unknown): string | null {
  const filePath = extractPath(toolArgs)
  if (!filePath || !isMemoryPath(filePath)) return null

  // Normalize to canonical /data/memory/... path
  const memoryIndex = filePath.indexOf('/memory/')
  if (memoryIndex !== -1) {
    return `/data${filePath.substring(memoryIndex)}`
  }

  return filePath.split('/').pop() ?? null
}

/**
 * Path of a memory file relative to the memory root (`MEMORY.md`,
 * `wiki/llm-systems.md`, `daily/2026-04-05.md`). Config files outside the
 * memory directory fall back to their file name.
 */
export function extractMemoryRelativePath(toolArgs: unknown): string | null {
  const filePath = extractPath(toolArgs)
  if (!filePath || !isMemoryPath(filePath)) return null
  return toMemoryRelativePath(filePath)
}

function toMemoryRelativePath(filePath: string): string | null {
  const memoryIndex = filePath.indexOf('/memory/')
  if (memoryIndex !== -1) {
    return filePath.substring(memoryIndex + '/memory/'.length)
  }
  return filePath.split('/').pop() ?? null
}

/**
 * Extract the written content from a write_file tool call on a memory file.
 * The chat view renders this as an "all-added" diff for memory writes — note
 * that for surgical changes the agent should use `edit_file`, which produces
 * a real before/after view from its `edits` args.
 */
export function extractMemoryWriteContent(toolName: string, toolArgs: unknown): string | null {
  if (toolName !== 'write_file' && toolName !== 'Write') return null
  if (!toolArgs || typeof toolArgs !== 'object') return null

  const args = toolArgs as Record<string, unknown>
  const filePath = extractPath(args)
  if (!filePath || !isMemoryPath(filePath)) return null

  const content = args.content
  if (typeof content !== 'string') return null

  return content
}

/**
 * Extract edits from an edit_file tool call's args.
 * Returns array of { oldText, newText } if present, null otherwise.
 */
export function extractEditsFromArgs(toolArgs: unknown): Array<{ oldText: string; newText: string }> | null {
  if (!toolArgs || typeof toolArgs !== 'object') return null
  const args = toolArgs as Record<string, unknown>
  const edits = args.edits
  if (!Array.isArray(edits) || edits.length === 0) return null

  const valid = edits.every(
    (e: unknown) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).oldText === 'string' && typeof (e as Record<string, unknown>).newText === 'string',
  )
  if (!valid) return null

  return edits as Array<{ oldText: string; newText: string }>
}
