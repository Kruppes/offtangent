/**
 * The output budget of `interview.v1`.
 *
 * Live acceptance run 2026-09-30 (audit log `isolated-inference.audit.jsonl`,
 * service `interview-acceptance-20260930`): 22 of 32 gateway calls failed with
 * `bad_model_output`, every single one of them with
 * `outputTokens == maxOutputTokens` — the model was cut off mid JSON. The
 * calling service could not tell "the model wrote garbage" from "the budget
 * was too small", so it degraded to its deterministic fallback and showed the
 * result as a normal interview turn.
 *
 * Two things are pinned here:
 *  1. a run that stops because of the token budget is reported as its own
 *     error code `output_truncated`, never as a successful answer and never as
 *     the generic `bad_model_output`,
 *  2. the profile ceiling, which is the only thing that limits what a caller
 *     may ask for (the request value is clamped, never taken as is).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  ISOLATED_INFERENCE_PROFILES,
  isolatedInferenceUsage,
  parseIsolatedRequest,
  resetIsolatedInferenceState,
  runIsolatedInference,
  type IsolatedCompletion,
  type IsolatedInferenceAuditEntry,
  type IsolatedInferenceService,
} from './isolated-inference.js'

const TOKEN = 'synthetic-service-token-for-tests-0002'
const TOKEN_SHA = createHash('sha256').update(TOKEN, 'utf8').digest('hex')

function service(overrides: Partial<IsolatedInferenceService> = {}): IsolatedInferenceService {
  return {
    id: 'budget-service',
    tokenSha256: TOKEN_SHA,
    profiles: ['interview.v1'],
    maxConcurrent: 2,
    dailyCallBudget: 5,
    expiresAt: '',
    revoked: false,
    ...overrides,
  }
}

function assistant(text: string, stopReason: AssistantMessage['stopReason'], output: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    usage: { input: 900, output, cacheRead: 0, cacheWrite: 0, totalTokens: 900 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage
}

/** Exactly the shape the live run produced: valid JSON start, no closing. */
const TRUNCATED = '{"nextQuestion":"Wie viele Anrufe kommen an einem normalen Tag rein?","coverage":{"mengengeruest":"partial"},"facts":[{"text":"Rund dreißig Anrufe am Tag, davon '

describe('interview.v1 output budget', () => {
  const resolved = {
    model: { id: 'claude-sonnet-5-5', provider: 'anthropic-test' },
    apiKey: 'no-key',
    providerId: 'anthropic-test',
    modelId: 'claude-sonnet-5-5',
  }

  beforeEach(() => resetIsolatedInferenceState())

  function run(
    complete: IsolatedCompletion,
    svc = service(),
    audit: (entry: IsolatedInferenceAuditEntry) => void = () => {},
    maxOutputTokens = 2400,
  ) {
    return runIsolatedInference(
      svc,
      { profile: 'interview.v1', input: 'ZUSTAND: …', maxOutputTokens },
      { complete, resolveModel: async () => resolved as never, stillValid: () => true, audit },
    )
  }

  it('reports a budget stop as output_truncated, not as bad model output', async () => {
    const entries: IsolatedInferenceAuditEntry[] = []
    await expect(run(async () => assistant(TRUNCATED, 'length', 2400), service(), e => entries.push(e)))
      .rejects.toMatchObject({ code: 'output_truncated', status: 502 })
    expect(entries.at(-1)?.code).toBe('output_truncated')
    expect(entries.at(-1)?.outputTokens).toBe(2400)
  })

  it('does not hand out a JSON object that was cut off at the budget', async () => {
    // A truncated answer can still parse when the cut happens to land after a
    // closing brace of a prefix object. Accepting it would deliver silently
    // incomplete interview state, which is worse than an error.
    await expect(run(async () => assistant('{"nextQuestion":"Und dann?"}', 'length', 2400)))
      .rejects.toMatchObject({ code: 'output_truncated' })
  })

  it('keeps the budget unit spent and frees the slot after a truncated answer', async () => {
    const svc = service()
    await expect(run(async () => assistant(TRUNCATED, 'length', 2400), svc)).rejects.toMatchObject({ code: 'output_truncated' })
    expect(isolatedInferenceUsage(svc).callsToday).toBe(1)
    expect(isolatedInferenceUsage(svc).inFlight).toBe(0)
  })

  it('says nothing about the provider in the truncation message', async () => {
    await run(async () => assistant(TRUNCATED, 'length', 2400)).catch((err: unknown) => {
      const message = String((err as Error).message)
      expect(message).toBe('model output hit the output token budget')
      expect(message).not.toMatch(/anthropic|api|key|http/i)
    })
    expect.assertions(2)
  })

  it('still answers normally when the model stops on its own', async () => {
    const result = await run(async () => assistant('{"nextQuestion":"Weiter?","done":false}', 'stop', 40))
    expect(result.json).toEqual({ nextQuestion: 'Weiter?', done: false })
    expect(result.usage.outputTokens).toBe(40)
  })

  it('carries the interview client budget: 2400 requested is 2400 granted', () => {
    // The interview client asks for a max output budget of 2400, derived
    // from the bounded delta contract (~5700 characters / ~2.6 characters per
    // token for German JSON = ~2200 tokens, plus ~10 % head room).
    const parsed = parseIsolatedRequest({ profile: 'interview.v1', input: 'x', maxOutputTokens: 2400 }, service())
    expect(parsed.maxOutputTokens).toBe(2400)
  })

  it('clamps a caller that asks for more than the profile ceiling', () => {
    const ceiling = ISOLATED_INFERENCE_PROFILES['interview.v1'].maxOutputTokens
    expect(ceiling).toBe(3000)
    const parsed = parseIsolatedRequest({ profile: 'interview.v1', input: 'x', maxOutputTokens: 100_000 }, service())
    expect(parsed.maxOutputTokens).toBe(ceiling)
  })
})
