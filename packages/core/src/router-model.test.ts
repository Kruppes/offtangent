/**
 * The default router chain names the newest Sonnet first. An instance that has
 * not enabled that model must keep working: an unresolvable chain entry is
 * skipped, so the chain degrades to the next entry instead of failing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_ROUTER_CHAIN, parseRouterChain, resolveRouterChain, resetRouterModelWarnings } from './router-model.js'

let tmpDir = ''
const originalDataDir = process.env.DATA_DIR

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = ''
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
  else delete process.env.DATA_DIR
  resetRouterModelWarnings()
})

function setupProviders(enabledModels: string[]): void {
  tmpDir = path.join(os.tmpdir(), `axiom-router-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'config', 'providers.json'),
    JSON.stringify({
      providers: [{
        id: 'anth-1',
        name: 'Anthropic',
        type: 'anthropic-messages',
        providerType: 'anthropic-oauth',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        enabledModels,
      }],
    }, null, 2),
    'utf-8',
  )
  process.env.DATA_DIR = tmpDir
}

describe('DEFAULT_ROUTER_CHAIN', () => {
  it('asks for the newest Sonnet first', () => {
    expect(parseRouterChain(DEFAULT_ROUTER_CHAIN).map(e => e.spec)[0]).toBe('claude-sonnet-5-5')
  })

  it('resolves to Sonnet 5.5 when the model is enabled', () => {
    setupProviders(['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-5'])
    const resolved = resolveRouterChain(parseRouterChain(DEFAULT_ROUTER_CHAIN))
    expect(resolved[0]?.composite).toBe('anth-1:claude-sonnet-5-5')
  })

  it('skips Sonnet 5.5 on an instance that has not enabled it', () => {
    setupProviders(['claude-opus-5', 'claude-sonnet-5'])
    const resolved = resolveRouterChain(parseRouterChain(DEFAULT_ROUTER_CHAIN))
    expect(resolved.map(e => e.modelId)).toEqual(['claude-sonnet-5'])
  })
})
