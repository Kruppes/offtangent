import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pi-models.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

import { completeSimple } from './pi-models.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  extractAndStoreFacts,
  isDuplicateFact,
  parseFactLines,
  parseFacts,
} from './fact-extraction.js'
import { createMemory, listMemories, searchMemories } from './memories-store.js'

const mockCompleteSimple = vi.mocked(completeSimple)

function insertUser(db: Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, 'hash', 'user')
}

function makeModel() {
  return {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function makeResponse(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    usage: {
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 140,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    model: 'gpt-4o-mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

describe('fact-extraction', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'bob')
    mockCompleteSimple.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  it('parseFactLines handles bullet lists, numbered lists, empty lines, and NO_FACTS', () => {
    expect(parseFactLines('- User prefers dark mode\n- Project uses PostgreSQL')).toEqual([
      'User prefers dark mode',
      'Project uses PostgreSQL',
    ])

    expect(parseFactLines('1. User works in Berlin\n\n2) Deployment uses Docker Compose')).toEqual([
      'User works in Berlin',
      'Deployment uses Docker Compose',
    ])

    expect(parseFactLines('  NO_FACTS  ')).toEqual([])
    expect(parseFactLines('\n\n')).toEqual([])
  })

  it('parseFacts detects the [shared] marker and defaults to persona scope', () => {
    expect(parseFacts([
      '- [shared] The Halfway pricing model lives in packages/pricing/tiers.ts',
      '- User prefers dark mode',
      '- [SHARED] Looplab routing is configured in router.yaml',
    ].join('\n'))).toEqual([
      { content: 'The Halfway pricing model lives in packages/pricing/tiers.ts', scope: 'shared', provenance: 'owner', supersessionKey: null },
      { content: 'User prefers dark mode', scope: 'persona', provenance: 'owner', supersessionKey: null },
      { content: 'Looplab routing is configured in router.yaml', scope: 'shared', provenance: 'owner', supersessionKey: null },
    ])

    expect(parseFacts('NO_FACTS')).toEqual([])
  })

  it('parseFactLines strips the [shared] marker from fact content', () => {
    expect(parseFactLines('- [shared] Halfway pricing lives in tiers.ts\n- Plain persona fact')).toEqual([
      'Halfway pricing lives in tiers.ts',
      'Plain persona fact',
    ])
  })

  it('isDuplicateFact returns true for highly overlapping facts', () => {
    createMemory(db, 1, 'session-a', 'The project uses PostgreSQL on port 5433', 'extracted_fact')

    expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433')).toBe(true)
  })

  it('isDuplicateFact ignores memories from different users', () => {
    createMemory(db, 2, 'session-b', 'The project uses PostgreSQL on port 5433', 'extracted_fact')

    expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433')).toBe(false)
  })

  it('isDuplicateFact checks across the bucket boundary (persona + shared)', () => {
    createMemory(db, 1, 'session-a', 'The Halfway pricing model uses three tiers', 'extracted_fact', 'shared')
    createMemory(db, 1, 'session-a', 'Bob deployed the scanner on the NUC', 'extracted_fact', 'bob')

    // A fact already in 'shared' is a duplicate for any persona bucket
    expect(isDuplicateFact(db, 1, 'Halfway pricing model uses three tiers', 'bob')).toBe(true)
    expect(isDuplicateFact(db, 1, 'Halfway pricing model uses three tiers', 'gekko')).toBe(true)
    // A fact in bob's bucket is a duplicate for bob …
    expect(isDuplicateFact(db, 1, 'Bob deployed the scanner on the NUC', 'bob')).toBe(true)
    // … but NOT for another persona (no cross-persona dedupe)
    expect(isDuplicateFact(db, 1, 'Bob deployed the scanner on the NUC', 'gekko')).toBe(false)
  })

  it('extractAndStoreFacts stores [shared]-marked facts under agent_id=shared', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse([
      '- [shared] The Halfway pricing model is implemented in tiers.ts',
      '- Bob prefers vitest for unit tests',
    ].join('\n')))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-bob',
      'User: transcript',
      makeModel(),
      'test-key',
      undefined,
      'bob',
    )

    expect(result).toEqual({ extracted: 2, stored: 2, duplicates: 0 })

    const facts = listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts
    const byContent = new Map(facts.map(fact => [fact.content, fact.agentId]))
    expect(byContent.get('The Halfway pricing model is implemented in tiers.ts')).toBe('shared')
    expect(byContent.get('Bob prefers vitest for unit tests')).toBe('bob')
  })

  it('extractAndStoreFacts does not duplicate a shared fact into a persona bucket', async () => {
    createMemory(db, 1, 'session-old', 'The Halfway pricing model is implemented in tiers.ts', 'extracted_fact', 'shared')
    mockCompleteSimple.mockResolvedValueOnce(makeResponse(
      '- The Halfway pricing model is implemented in tiers.ts',
    ))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-gekko',
      'User: transcript',
      makeModel(),
      'test-key',
      undefined,
      'gekko',
    )

    expect(result).toEqual({ extracted: 1, stored: 0, duplicates: 1 })
  })

  it('shared facts are visible to personas and to main via retrieval', () => {
    createMemory(db, 1, 'session-a', 'The Halfway pricing model uses three tiers', 'extracted_fact', 'shared')
    createMemory(db, 1, 'session-a', 'Bob deployed the scanner on the NUC', 'extracted_fact', 'bob')

    const bobHits = searchMemories(db, 'Halfway pricing', { userId: 1, agentId: 'bob' }).map(f => f.content)
    expect(bobHits).toContain('The Halfway pricing model uses three tiers')

    const mainHits = searchMemories(db, 'Halfway pricing', { userId: 1, agentId: 'main' }).map(f => f.content)
    expect(mainHits).toContain('The Halfway pricing model uses three tiers')

    // Persona-scoped fact stays out of other personas' retrieval
    const gekkoHits = searchMemories(db, 'scanner NUC', { userId: 1, agentId: 'gekko' }).map(f => f.content)
    expect(gekkoHits).not.toContain('Bob deployed the scanner on the NUC')
  })

  it('extractAndStoreFacts calls the LLM, wraps the transcript, deduplicates, and stores new facts', async () => {
    createMemory(db, 1, 'session-old', 'Deployment is done via Docker Compose with 3 services', 'extracted_fact')
    mockCompleteSimple.mockResolvedValueOnce(makeResponse([
      '- Deployment is done via Docker Compose with 3 services',
      '- The project uses PostgreSQL on port 5433',
      '- User prefers dark mode in all applications',
    ].join('\n')))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-new',
      'User: Please remember that I prefer dark mode.\nAssistant: Got it.',
      makeModel(),
      'test-key',
    )

    expect(result).toEqual({ extracted: 3, stored: 2, duplicates: 1 })
    expect(mockCompleteSimple).toHaveBeenCalledOnce()

    const [, prompt, options] = mockCompleteSimple.mock.calls[0]
    expect(prompt.systemPrompt).toContain('extract atomic, reusable facts')
    expect(prompt.messages[0].content).toContain('<transcript>\nUser: Please remember that I prefer dark mode.')
    expect(prompt.messages[0].content).toContain('\n</transcript>')
    expect(options).toMatchObject({ apiKey: 'test-key' })
    // claude-sonnet-5 and friends reject `temperature` with a 400.
    expect(options).not.toHaveProperty('temperature')

    const storedFacts = listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts
      .filter(fact => fact.source === 'extracted_fact')
      .map(fact => fact.content)

    expect(storedFacts).toContain('The project uses PostgreSQL on port 5433')
    expect(storedFacts).toContain('User prefers dark mode in all applications')
  })

  it('returns zero counts when the LLM says NO_FACTS', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('NO_FACTS'))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-empty',
      'User: Hello\nAssistant: Hi there',
      makeModel(),
      'test-key',
    )

    expect(result).toEqual({ extracted: 0, stored: 0, duplicates: 0 })
    expect(listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts).toHaveLength(0)
  })

  it('throws when the provider rejects the request instead of storing zero facts', async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      ...makeResponse(''),
      content: [],
      stopReason: 'error' as const,
      errorMessage: '400 `temperature` is deprecated for this model.',
    })

    await expect(extractAndStoreFacts(
      db,
      1,
      'session-error',
      'User: remember X\nAssistant: ok',
      makeModel(),
      'test-key',
    )).rejects.toThrow('temperature')
  })

  it('propagates LLM errors so callers can handle them', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('LLM unavailable'))

    await expect(extractAndStoreFacts(
      db,
      1,
      'session-error',
      'User: remember this',
      makeModel(),
      'test-key',
    )).rejects.toThrow('LLM unavailable')
  })

  it('parseFacts reads the [untrusted] marker and the {key: ...} suffix (SPEC 11.4)', () => {
    expect(parseFacts([
      '- User works from Berlin now {key: user.location}',
      '- [untrusted] The library released version 2.3 last week {key: Lib Version}',
      '- [shared] [untrusted] Fetched pricing page lists 3 tiers',
    ].join('\n'))).toEqual([
      { content: 'User works from Berlin now', scope: 'persona', provenance: 'owner', supersessionKey: 'user.location' },
      { content: 'The library released version 2.3 last week', scope: 'persona', provenance: 'untrusted', supersessionKey: 'lib.version' },
      { content: 'Fetched pricing page lists 3 tiers', scope: 'shared', provenance: 'untrusted', supersessionKey: null },
    ])
  })

  it('skips non interactive session kinds without a model call (gate 1)', async () => {
    const result = await extractAndStoreFacts(db, 1, 's-task', 'User: x\nAssistant: y', makeModel(), 'k', undefined, 'main', 'task')
    expect(result.stored).toBe(0)
    expect(result.skipped).toContain('task')
    expect(mockCompleteSimple).not.toHaveBeenCalled()
  })

  it('strips recalled lines before extraction and skips a transcript of only recalled content (gate 2)', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User likes tea'))
    await extractAndStoreFacts(
      db, 1, 's1',
      '[recalled] 1. User likes coffee\nUser: I like tea\nAssistant: noted',
      makeModel(), 'k',
    )
    const [, prompt] = mockCompleteSimple.mock.calls[0]
    expect(prompt.messages[0].content).not.toContain('coffee')
    expect(prompt.messages[0].content).toContain('User: I like tea')

    const onlyRecalled = await extractAndStoreFacts(db, 1, 's2', '[recalled] 1. fact\n[recalled] 2. fact', makeModel(), 'k')
    expect(onlyRecalled.skipped).toContain('recalled')
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1)
  })

  it('stores provenance and supersedes the previous active fact with the same key (gates 3 and 4)', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User lives in Hamburg {key: user.location}\n- [untrusted] Weather site says rain tomorrow'))
    await extractAndStoreFacts(db, 1, 's1', 'User: I live in Hamburg\nAssistant: ok', makeModel(), 'k')
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User moved to Berlin {key: user.location}'))
    await extractAndStoreFacts(db, 1, 's2', 'User: I moved to Berlin\nAssistant: ok', makeModel(), 'k')

    const all = listMemories(db, { userId: 1, includeSuperseded: true }).facts
    const hamburg = all.find(f => f.content.includes('Hamburg'))!
    const berlin = all.find(f => f.content.includes('Berlin'))!
    const weather = all.find(f => f.content.includes('rain'))!
    expect(hamburg.status).toBe('superseded')
    expect(hamburg.supersededBy).toBe(berlin.id)
    expect(hamburg.sessionKind).toBe('interactive')
    expect(berlin.status).toBe('active')
    expect(berlin.supersessionKey).toBe('user.location')
    expect(weather.provenance).toBe('untrusted')

    // Retrieval sees the active owner fact only.
    const hits = searchMemories(db, 'Hamburg Berlin rain', { userId: 1 })
    expect(hits.map(f => f.content)).toEqual(['User moved to Berlin'])
    // The default list hides superseded rows but shows untrusted ones.
    const listed = listMemories(db, { userId: 1 }).facts.map(f => f.content)
    expect(listed).toContain('Weather site says rain tomorrow')
    expect(listed).not.toContain('User lives in Hamburg')
  })
})
