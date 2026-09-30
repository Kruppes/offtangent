/**
 * `ask_connector` — the only door from a normal agent to private connector
 * data (plan 2026-09-26, P2).
 *
 * Covered here: the static description, the connected-connector list on a bad
 * id, the untrusted envelope, the secret redaction of the result, and the
 * source-level gate that keeps `createTools(` inside the runner.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from '../database.js'
import { createBaseAgentTools } from '../agent-runtime.js'
import { withSecretBoundary, REDACTED_HANDLE } from '../secret-boundary.js'
import { invalidateSecretHandleCache } from '../secret-store.js'
import { setSecret } from '../secrets-config.js'
import { createAskConnectorTool, CONNECTOR_UNTRUSTED_NOTE } from './ask-connector-tool.js'
import { createMailboxConnectorManifest } from './mailbox.fixture.js'
import type { ConnectorSubAgentResult } from './sub-agent.js'

const manifest = createMailboxConnectorManifest()
const other = createMailboxConnectorManifest({ id: 'mailbox-two' })

function okResult(answer: string): ConnectorSubAgentResult {
  return { ok: true, answer, connectorId: manifest.id, toolCalls: 1, durationMs: 5, truncated: false, limitHit: false, timedOut: false }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(part => (part.type === 'text' ? part.text ?? '' : '')).join('')
}

let dataDir = ''

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-ask-connector-'))
  process.env.DATA_DIR = dataDir
  process.env.ENCRYPTION_KEY = '0'.repeat(64)
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
  invalidateSecretHandleCache()
})

afterEach(() => {
  delete process.env.DATA_DIR
  delete process.env.ENCRYPTION_KEY
  fs.rmSync(dataDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
})

describe('ask_connector tool', () => {
  it('has a static description without a connector list', () => {
    const withNone = createAskConnectorTool({ listManifests: () => [], getStatus: () => 'connected' })
    const withTwo = createAskConnectorTool({ listManifests: () => [manifest, other], getStatus: () => 'connected' })
    // Same schema regardless of what is connected — the prompt cache depends on it.
    expect(withTwo.description).toBe(withNone.description)
    expect(withTwo.description).not.toContain(manifest.id)
    expect(JSON.stringify(withTwo.parameters)).toBe(JSON.stringify(withNone.parameters))
  })

  it('answers an unknown id with the list of connected connectors', async () => {
    const tool = createAskConnectorTool({
      listManifests: () => [manifest, other],
      getStatus: m => (m.id === manifest.id ? 'connected' : 'disconnected'),
      run: async () => okResult('never'),
    })
    const text = textOf(await tool.execute('c1', { connector: 'nope', question: 'Was?' }) as never)
    expect(text).toContain('unknown or unconnected connector "nope"')
    expect(text).toContain(manifest.id)
    expect(text).not.toContain(other.id)
  })

  it('reports "(none)" when nothing is connected', async () => {
    const tool = createAskConnectorTool({ listManifests: () => [manifest], getStatus: () => 'disconnected' })
    const text = textOf(await tool.execute('c2', { connector: manifest.id, question: 'Was?' }) as never)
    expect(text).toContain('(none)')
  })

  it('wraps a successful answer in the untrusted envelope', async () => {
    const tool = createAskConnectorTool({
      listManifests: () => [manifest],
      getStatus: () => 'connected',
      run: async () => okResult('Die Rechnung ist am 30.09.2026 fällig.'),
    })
    const text = textOf(await tool.execute('c3', { connector: manifest.id, question: 'Wann?' }) as never)
    expect(text).toContain(`<connector_result connector="${manifest.id}" trust="untrusted">`)
    expect(text).toContain('Die Rechnung ist am 30.09.2026 fällig.')
    expect(text).toContain('</connector_result>')
    expect(text).toContain(CONNECTOR_UNTRUSTED_NOTE)
  })

  it('passes a runner error through as an error sentence', async () => {
    const tool = createAskConnectorTool({
      listManifests: () => [manifest],
      getStatus: () => 'connected',
      run: async () => ({
        ok: false,
        answer: '',
        error: 'local_model_unreachable' as const,
        message: 'Lokales Modell nicht erreichbar',
        connectorId: manifest.id,
        toolCalls: 0,
        durationMs: 1,
        truncated: false,
        limitHit: false,
        timedOut: false,
      }),
    })
    const text = textOf(await tool.execute('c4', { connector: manifest.id, question: 'Wann?' }) as never)
    expect(text).toBe('Error: Lokales Modell nicht erreichbar')
  })

  it('runs the result through the existing secret redaction', async () => {
    // A connector answer that happens to contain a known secret value must not
    // reach the model in the clear — the same net every other tool gets.
    setSecret('DEMO_MAIL_TOKEN', 'mail-token-value-2026')
    invalidateSecretHandleCache()
    const tool = createAskConnectorTool({
      listManifests: () => [manifest],
      getStatus: () => 'connected',
      run: async () => okResult('Im Postfach steht DEMO_MAIL_TOKEN=mail-token-value-2026'),
    })
    const [wrapped] = withSecretBoundary([tool as AgentTool])
    const text = textOf(await wrapped.execute('c5', { connector: manifest.id, question: 'Token?' }) as never)
    expect(text).not.toContain('mail-token-value-2026')
    expect(text).toContain(REDACTED_HANDLE)
    expect(text).toContain('<connector_result')
  })

  it('is registered exactly once in createBaseAgentTools, and the raw connector tools are not', () => {
    const db = initDatabase(':memory:')
    try {
      const names = createBaseAgentTools({ db }).map(tool => tool.name)
      expect(names.filter(name => name === 'ask_connector')).toHaveLength(1)
      // The mailbox fixture's tool names must not appear in the base set.
      expect(names).not.toContain('search')
      expect(names).not.toContain('read')
    } finally {
      db.close()
    }
  })
})

describe('source gate: connector tools are built in one place only', () => {
  const repoRoot = path.resolve(__dirname, '../../../..')
  const scanned = ['packages/core/src', 'packages/web-backend/src']

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        out.push(...sourceFiles(full))
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.vue')) continue
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.fixture.ts')) continue
      out.push(full)
    }
    return out
  }

  it('only the sub-agent runner calls createTools(', () => {
    const hits: string[] = []
    for (const rel of scanned) {
      for (const file of sourceFiles(path.join(repoRoot, rel))) {
        const lines = fs.readFileSync(file, 'utf-8').split('\n')
        lines.forEach((line, index) => {
          if (!line.includes('createTools(')) return
          const rel2 = path.relative(repoRoot, file).replace(/\\/g, '/')
          if (!hits.includes(rel2)) hits.push(`${rel2}`)
          expect(index).toBeGreaterThan(0)
        })
      }
    }
    expect(hits).toEqual(['packages/core/src/connectors/sub-agent.ts'])
  })
})
