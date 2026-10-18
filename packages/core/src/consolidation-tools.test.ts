import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { scopedConsolidationTools } from './consolidation-tools.js'

describe('consolidation capability boundary', () => {
  it('removes escape tools, binds history and checks paths/symlinks', async () => {
    const root = path.join(process.env.WORKSPACE_DIR!, 'scope-tools-fixture')
    fs.mkdirSync(root, { recursive: true })
    const execute = vi.fn(async () => ({ content: [], details: {} }))
    const tools = ['shell', 'create_task', 'codemode', 'ask_connector', 'search_memories', 'read_file', 'write_file', 'edit_file', 'list_files', 'read_chat_history'].map(name => ({ name, label: name, description: '', parameters: {}, execute })) as unknown as AgentTool[]
    try {
      const scoped = scopedConsolidationTools(tools, root, 'owned-session')
      expect(scoped.map(t => t.name)).toEqual(['read_file', 'write_file', 'edit_file', 'list_files', 'read_chat_history'])
      expect(scopedConsolidationTools(tools)).toEqual([])
      await scoped[0].execute('1', { path: 'MEMORY.md' })
      expect(execute.mock.calls.at(-1)).toEqual(['1', { path: path.join(root, 'MEMORY.md') }, undefined, undefined])
      await expect(scoped[1].execute('2', { path: '../escape', content: 'OTHER_PROJECT' })).rejects.toThrow('Outside consolidation scope')
      await expect(scoped[1].execute('2a', { path: 'daily/2026-01-01.md', content: 'overwrite' })).rejects.toThrow('Read-only')
      await expect(scoped[2].execute('2b', { path: 'sources/raw.md', edits: [] })).rejects.toThrow('Read-only')
      await scoped[1].execute('2c', { path: 'wiki/fact.md', content: 'SCOPED_SENTINEL' })
      fs.symlinkSync(path.dirname(root), path.join(root, 'escape'))
      await expect(scoped[0].execute('3', { path: 'escape/foreign' })).rejects.toThrow('Symlink')
      await scoped[4].execute('4', { session_id: 'foreign-session', agent: 'all', query: 'sentinel' })
      expect(execute.mock.calls.at(-1)).toEqual(['4', { session_id: 'owned-session', agent: undefined, query: 'sentinel' }, undefined, undefined])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
