/**
 * Request-wire compatibility of every (model, thinking) pair the task policy
 * can choose automatically. The runner turns a task's thinking level into the
 * request's reasoning option via `toPiAiReasoning`; these tests capture the
 * real request body (fetch stubbed, nothing leaves the process) and check the
 * provider-specific rules:
 *  - Anthropic adaptive models must never receive `thinking: {type:"disabled"}`
 *    (400) — `off` has to omit the field — and never `temperature`.
 *  - No automatic level ever becomes `xhigh`/max effort on the wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { completeSimple } from './pi-models.js'
import { toPiAiReasoning } from './thinking-level.js'
import { TASK_POLICY_FAMILY_MODELS, TASK_POLICY_MATRIX } from './task-policy.js'
import type { AutomaticThinkingLevel } from './task-policy.js'

function anthropicProvider(providerType: 'anthropic' | 'anthropic-oauth', models: string[]): ProviderConfig {
  return {
    id: `anth-${providerType}`,
    name: 'Anthropic',
    type: 'anthropic-messages',
    providerType,
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    enabledModels: models,
  } as ProviderConfig
}

async function captureBody(provider: ProviderConfig, modelId: string, level: AutomaticThinkingLevel): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    return new Response('{"type":"error","error":{"message":"captured"}}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }))
  const model = buildModel(provider, modelId)
  await completeSimple(model, { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] }, {
    apiKey: 'sk-test',
    reasoning: toPiAiReasoning(level),
  } as never)
  expect(captured, `${modelId}/${level}: request captured`).toBeDefined()
  return captured!
}

/**
 * The effort that applies to the next turn. Models with mid-conversation
 * effort (Opus 5.5 on the subscription) carry it as a trailing system message
 * `{ role: "system", output_config: { effort } }`; the top-level
 * `output_config` is then a fixed envelope. Others use the top level.
 */
function effectiveEffort(body: Record<string, unknown>): string | undefined {
  const messages = (body.messages ?? []) as Array<{ role?: string; output_config?: { effort?: string } }>
  const last = messages[messages.length - 1]
  if (last?.role === 'system' && last.output_config?.effort) return last.output_config.effort
  return (body.output_config as { effort?: string } | undefined)?.effort
}

const AUTOMATIC_LEVELS: AutomaticThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']
const ANTHROPIC_MODELS = [...new Set(Object.values(TASK_POLICY_FAMILY_MODELS.anthropic).flat())]

describe('task policy request wire — Anthropic', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('the matrix only produces automatic levels', () => {
    const used = new Set(Object.values(TASK_POLICY_MATRIX).flatMap((row) => Object.values(row).map((c) => c.thinking)))
    for (const level of used) expect(AUTOMATIC_LEVELS).toContain(level)
  })

  // Subscription path (catalog models): both tier models. The api-key path
  // builds Opus from the user's own models[] config, so only the Sonnet
  // catalog override is checked there.
  const cases: Array<['anthropic' | 'anthropic-oauth', string]> = [
    ...ANTHROPIC_MODELS.map((m) => ['anthropic-oauth', m] as ['anthropic-oauth', string]),
    ['anthropic', 'claude-sonnet-5-5'],
  ]
  for (const [providerType, modelId] of cases) {
    for (const level of AUTOMATIC_LEVELS) {
      it(`${providerType} ${modelId} thinking=${level}: no disabled thinking, no temperature, no max effort`, async () => {
        const body = await captureBody(anthropicProvider(providerType, ANTHROPIC_MODELS), modelId, level)
        expect(body.model).toBe(modelId)
        expect(body).not.toHaveProperty('temperature')
        // `thinking: {type:"disabled"}` is rejected by these models (400).
        expect(body.thinking).not.toEqual({ type: 'disabled' })
        if (body.thinking !== undefined) expect(body.thinking).toMatchObject({ type: 'adaptive' })
        const effort = effectiveEffort(body)
        expect(['max', 'xhigh']).not.toContain(effort)
        expect(['max', 'xhigh']).not.toContain((body.output_config as { effort?: string } | undefined)?.effort)
        // From `low` on, the requested level reaches the wire unchanged.
        if (level === 'low' || level === 'medium' || level === 'high') expect(effort).toBe(level)
      })
    }
  }

  it('Sonnet 5.5 sends no thinking field at all for off', async () => {
    for (const providerType of ['anthropic', 'anthropic-oauth'] as const) {
      const body = await captureBody(anthropicProvider(providerType, ANTHROPIC_MODELS), 'claude-sonnet-5-5', 'off')
      expect(body.thinking, providerType).toBeUndefined()
    }
  })

  it('the matrix never puts the strong (Opus) tier on off/minimal, where the catalog forces adaptive thinking', () => {
    for (const row of Object.values(TASK_POLICY_MATRIX)) {
      for (const cell of Object.values(row)) {
        if (cell.tier === 'strong') expect(['off', 'minimal']).not.toContain(cell.thinking)
      }
    }
  })
})

describe('task policy reasoning option — OpenAI family', () => {
  // The Codex transport is not fetch-captured here; the contract checked is
  // the option the runner hands to pi-ai for every automatic level.
  it('no automatic level becomes xhigh; off sends no reasoning option', () => {
    for (const level of AUTOMATIC_LEVELS) {
      const reasoning = toPiAiReasoning(level)
      expect(reasoning).not.toBe('xhigh')
      if (level === 'off') expect(reasoning).toBeUndefined()
      else expect(reasoning).toBe(level)
    }
  })

  it('the OpenAI tier models are reasoning models in the Codex catalog', () => {
    const provider = {
      id: 'codex-test', name: 'Codex', type: 'openai-codex-responses', providerType: 'openai-codex',
      provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', apiKey: 'x',
      enabledModels: [...new Set(Object.values(TASK_POLICY_FAMILY_MODELS.openai).flat())],
    } as unknown as ProviderConfig
    for (const id of provider.enabledModels!) {
      const model = buildModel(provider, id) as { reasoning?: boolean; api?: string }
      expect(model.reasoning, id).toBe(true)
      expect(model.api, id).toBe('openai-codex-responses')
    }
  })
})
