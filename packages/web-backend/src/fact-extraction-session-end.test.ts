import { describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { initDatabase } from '@axiom/core'
import type { Database, ProviderConfig } from '@axiom/core'
import {
  resolveFactExtractionExecutionContext,
  triggerFactExtractionForSessionEnd,
} from './fact-extraction-session-end.js'

function insertSession(db: Database, input: { id: string; userId: number; messageCount: number }): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, source, started_at, ended_at, message_count, summary_written)
     VALUES (?, ?, 'web', datetime('now', '-5 minutes'), datetime('now'), ?, 1)`
  ).run(input.id, input.userId, input.messageCount)
}

function makeProvider(id: string, name: string): ProviderConfig {
  return {
    id,
    name,
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    enabledModels: ['gpt-4o-mini'],
    status: 'connected',
    authMethod: 'api-key',
  }
}

function makeModel(id = 'gpt-4o-mini'): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

describe('fact-extraction session-end trigger', () => {
  it('resolves a dedicated provider first and falls back to the active provider', async () => {
    const dedicatedProvider = makeProvider('dedicated', 'Dedicated')
    const activeProvider = makeProvider('active', 'Active')
    const buildModel = vi.fn((provider: ProviderConfig) => makeModel(provider.enabledModels?.[0]))
    const getApiKeyForProvider = vi.fn().mockResolvedValue('resolved-key')

    const dedicatedContext = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: 'dedicated', minSessionMessages: 3 },
      {
        loadProvidersDecrypted: () => ({ providers: [dedicatedProvider] }),
        getActiveProvider: () => activeProvider,
        buildModel,
        getApiKeyForProvider,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    )

    expect(dedicatedContext).not.toBeNull()
    expect(buildModel).toHaveBeenCalledWith(dedicatedProvider, 'gpt-4o-mini')
    expect(getApiKeyForProvider).toHaveBeenCalledWith(dedicatedProvider)

    buildModel.mockClear()
    getApiKeyForProvider.mockClear()

    const fallbackContext = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: '', minSessionMessages: 3 },
      {
        loadProvidersDecrypted: () => ({ providers: [dedicatedProvider] }),
        getActiveProvider: () => activeProvider,
        buildModel,
        getApiKeyForProvider,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    )

    expect(fallbackContext).not.toBeNull()
    expect(buildModel).toHaveBeenCalledWith(activeProvider, 'gpt-4o-mini')
    expect(getApiKeyForProvider).toHaveBeenCalledWith(activeProvider)
  })

  it('skips fact extraction when disabled or below the minimum message threshold', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-1', userId: 1, messageCount: 2 })

    const extractAndStoreFacts = vi.fn().mockResolvedValue({ extracted: 1, stored: 1, duplicates: 0 })
    const historyProvider = {
      getSessionManager: () => ({
        buildConversationHistory: vi.fn(() => 'User: hi'),
      }),
    }

    expect(triggerFactExtractionForSessionEnd({
      db,
      agentCore: historyProvider,
      userId: '1',
      sessionId: 'session-1',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: false, providerId: '', minSessionMessages: 3 } }),
        extractAndStoreFacts,
      },
    })).toBe(false)

    expect(triggerFactExtractionForSessionEnd({
      db,
      agentCore: historyProvider,
      userId: '1',
      sessionId: 'session-1',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        extractAndStoreFacts,
      },
    })).toBe(false)

    await Promise.resolve()
    expect(extractAndStoreFacts).not.toHaveBeenCalled()
    db.close()
  })

  it('skips fact extraction when the session has no numeric user scope', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-guest', userId: 1, messageCount: 4 })
    db.prepare(
      'UPDATE sessions SET user_id = NULL, session_user = ? WHERE id = ?'
    ).run('telegram-123', 'session-guest')

    const extractAndStoreFacts = vi.fn().mockResolvedValue({ extracted: 1, stored: 1, duplicates: 0 })
    const buildConversationHistory = vi.fn(() => 'User: remember this')
    const warn = vi.fn()

    const triggered = triggerFactExtractionForSessionEnd({
      db,
      agentCore: {
        getSessionManager: () => ({ buildConversationHistory }),
      },
      userId: 'telegram-123',
      sessionId: 'session-guest',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        extractAndStoreFacts,
        console: { log: vi.fn(), warn, error: vi.fn() },
      },
    })

    expect(triggered).toBe(false)
    expect(buildConversationHistory).not.toHaveBeenCalled()
    expect(extractAndStoreFacts).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[fact-extraction] Skipping session session-guest: no numeric user ID available')

    db.close()
  })

  it('fires-and-forgets extraction after session end and catches failures', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-2', userId: 1, messageCount: 4 })

    const extractAndStoreFacts = vi.fn().mockRejectedValue(new Error('boom'))
    const log = vi.fn()
    const error = vi.fn()
    const buildConversationHistory = vi.fn(() => 'User: remember that I use dark mode')

    const triggered = triggerFactExtractionForSessionEnd({
      db,
      agentCore: {
        getSessionManager: () => ({ buildConversationHistory }),
      },
      userId: '1',
      sessionId: 'session-2',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        getActiveProvider: () => makeProvider('active', 'Active'),
        buildModel: vi.fn(() => makeModel('gpt-4o-mini')),
        getApiKeyForProvider: vi.fn().mockResolvedValue('key'),
        extractAndStoreFacts,
        console: { log, warn: vi.fn(), error },
      },
    })

    expect(triggered).toBe(true)
    expect(buildConversationHistory).toHaveBeenCalledOnce()
    expect(extractAndStoreFacts).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(extractAndStoreFacts).toHaveBeenCalledWith(
        db,
        1,
        'session-2',
        'User: remember that I use dark mode',
        expect.objectContaining({ id: 'gpt-4o-mini' }),
        'key',
        expect.objectContaining({ providerType: 'openai' }),
        'main',
        'interactive',
      )
      expect(error).toHaveBeenCalled()
    })

    expect(log).not.toHaveBeenCalled()
    expect(String(error.mock.calls[0][0])).toContain('[fact-extraction] Failed for session session-2:')

    db.close()
  })

  it('scopes extracted facts to the session persona (multi-persona bleeding regression)', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-bob', userId: 1, messageCount: 4 })
    db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run('bob', 'session-bob')

    const extractAndStoreFacts = vi.fn().mockResolvedValue({ extracted: 1, stored: 1, duplicates: 0 })
    const buildConversationHistory = vi.fn(() => 'User: the chain waxing interval is 300km')

    const triggered = triggerFactExtractionForSessionEnd({
      db,
      agentCore: {
        getSessionManager: () => ({ buildConversationHistory }),
      },
      userId: '1',
      sessionId: 'session-bob',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        getActiveProvider: () => makeProvider('active', 'Active'),
        buildModel: vi.fn(() => makeModel('gpt-4o-mini')),
        getApiKeyForProvider: vi.fn().mockResolvedValue('key'),
        extractAndStoreFacts,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    })

    expect(triggered).toBe(true)
    await vi.waitFor(() => {
      expect(extractAndStoreFacts).toHaveBeenCalledWith(
        db,
        1,
        'session-bob',
        'User: the chain waxing interval is 300km',
        expect.objectContaining({ id: 'gpt-4o-mini' }),
        'key',
        expect.objectContaining({ providerType: 'openai' }),
        'bob',
        'interactive',
      )
    })

    db.close()
  })

  it('never extracts from task, heartbeat or consolidation sessions (SPEC 11.4 gate 1)', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-task', userId: 1, messageCount: 9 })
    db.prepare("UPDATE sessions SET type = 'task' WHERE id = ?").run('session-task')

    const extractAndStoreFacts = vi.fn().mockResolvedValue({ extracted: 1, stored: 1, duplicates: 0 })
    const buildConversationHistory = vi.fn(() => 'User: a\nAssistant: b')
    const log = vi.fn()

    const triggered = triggerFactExtractionForSessionEnd({
      db,
      agentCore: { getSessionManager: () => ({ buildConversationHistory }) },
      userId: '1',
      sessionId: 'session-task',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        getActiveProvider: () => makeProvider('active', 'Active'),
        extractAndStoreFacts,
        console: { log, warn: vi.fn(), error: vi.fn() },
      },
    })

    expect(triggered).toBe(false)
    expect(buildConversationHistory).not.toHaveBeenCalled()
    expect(extractAndStoreFacts).not.toHaveBeenCalled()
    expect(String(log.mock.calls[0][0])).toContain('produces no durable facts')
    db.close()
  })

  it('reads the interactive session without its task descendants', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-own', userId: 1, messageCount: 4 })
    const buildConversationHistory = vi.fn(() => 'User: own only')
    const extractAndStoreFacts = vi.fn().mockResolvedValue({ extracted: 0, stored: 0, duplicates: 0 })

    triggerFactExtractionForSessionEnd({
      db,
      agentCore: { getSessionManager: () => ({ buildConversationHistory }) },
      userId: '1',
      sessionId: 'session-own',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        getActiveProvider: () => makeProvider('active', 'Active'),
        buildModel: vi.fn(() => makeModel('gpt-4o-mini')),
        getApiKeyForProvider: vi.fn().mockResolvedValue('key'),
        extractAndStoreFacts,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    })

    expect(buildConversationHistory).toHaveBeenCalledWith('session-own', { includeDescendants: false })
    await vi.waitFor(() => expect(extractAndStoreFacts).toHaveBeenCalled())
    db.close()
  })
})
