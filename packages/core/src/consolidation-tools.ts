import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** Consolidation is a data transform, not an autonomous shell worker. No escape
 * through shell, delegation, codemode, connectors or cross-scope retrieval. */
export function scopedConsolidationTools(tools: AgentTool[], root?: string, originSessionId?: string, assertScopeCurrent?: () => void): AgentTool[] {
  if (!root || !originSessionId) return []
  const base = path.resolve(root)
  const allowed = new Set(['read_file', 'write_file', 'edit_file', 'list_files', 'read_chat_history'])
  const checkPath = (input: unknown): string => {
    if (typeof input !== 'string') throw new Error('Scoped consolidation requires a path')
    const target = path.resolve(base, input)
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Outside consolidation scope')
    // Reject symlinks in ALL existing ancestors (including the configured root).
    let current = path.parse(target).root
    for (const segment of target.slice(current.length).split(path.sep)) {
      current = path.join(current, segment)
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink outside consolidation boundary') }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
    }
    return target
  }
  return tools.filter(tool => allowed.has(tool.name)).map(tool => ({ ...tool,
    execute: async (id, params, signal, onUpdate) => {
      // Revalidate for EVERY capability, not just when the queued task starts.
      // Production file writes are synchronous before their first await; no
      // event-loop scope switch can occur between this check and the write.
      assertScopeCurrent?.()
      const args = params as Record<string, unknown>
      if (tool.name === 'read_chat_history') {
        // Force the exact owned source session; never accept a query over other scopes/personas.
        const result = await tool.execute(id, { ...args, session_id: originSessionId, agent: undefined }, signal, onUpdate)
        assertScopeCurrent?.() // Discard a read that crossed a scope change.
        return result
      }
      const target = checkPath(args.path)
      if (tool.name === 'write_file' || tool.name === 'edit_file') {
        const rel = path.relative(base, target)
        if (rel !== 'MEMORY.md' && !/^(wiki|users)\/.+\.md$/.test(rel)) throw new Error('Read-only consolidation source')
      }
      const result = await tool.execute(id, { ...args, path: target }, signal, onUpdate)
      assertScopeCurrent?.()
      return result
    },
  }))
}
