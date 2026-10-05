// Live smoke (plan 2026-10-05-ollama-native-gemma-qwen): real core dist code
// (buildModel + buildStreamFn + streamSimple) against a native Ollama server.
// Synthetic prompt only; logs the wire fields that matter (model, think,
// options.num_ctx) by wrapping fetch, plus /api/ps context_length afterwards.
// Usage: node scripts/dev/ollama-native-gq-smoke.mjs <baseUrl> <case...>
import { buildModel, streamSimple } from '../../packages/core/dist/index.js'
import { buildStreamFn } from '../../packages/core/dist/provider-config.js'

const baseUrl = process.argv[2]
const cases = process.argv.slice(3)
const wire = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/api/chat') && init?.body) {
    const b = JSON.parse(init.body)
    wire.push({ model: b.model, think: Object.hasOwn(b, 'think') ? b.think : '(absent)', num_ctx: b.options?.num_ctx ?? '(absent)', messages: b.messages.length })
  }
  return realFetch(url, init)
}

const provider = (models) => ({
  id: 'smoke-native', name: 'smoke', type: 'ollama-chat', provider: 'ollama-native', providerType: 'ollama-native', baseUrl, apiKey: '',
  enabledModels: models.map(m => m.id), defaultModel: models[0].id, models,
})

async function run({ label, modelId, reasoningMeta, baseline, choice, reasoning }) {
  const models = [{ id: modelId, ...(reasoningMeta ? { reasoning: true } : {}), ...(baseline ? { ollamaNumCtx: baseline } : {}) }]
  const cfg = provider(models)
  const model = buildModel(cfg, modelId)
  const fn = buildStreamFn(cfg, streamSimple, { getSessionId: () => 'smoke-session', getContextWindowChoice: () => choice })
  const before = wire.length
  const t0 = Date.now()
  const s = fn(model, { systemPrompt: 'Reply with one word.', messages: [{ role: 'user', content: 'Say OK.', timestamp: Date.now() }] }, { apiKey: 'no-key', maxTokens: reasoning ? 256 : 16, ...(reasoning ? { reasoning } : {}) })
  let thinkingChars = 0
  let text = ''
  let err
  for await (const ev of s) {
    if (ev.type === 'thinking_delta') thinkingChars += ev.delta.length
    if (ev.type === 'text_delta') text += ev.delta
    if (ev.type === 'error') err = ev.error?.errorMessage
  }
  const ps = await (await realFetch(`${baseUrl}/api/ps`)).json()
  const loaded = ps.models.find(m => m.name === modelId)
  console.log(JSON.stringify({ label, sent: wire.slice(before), thinkingChars, text: text.slice(0, 20), err, ms: Date.now() - t0, ps_context_length: loaded?.context_length ?? null, modelReasoning: model.reasoning, modelApi: model.api }))
}

const CASES = {
  'qwen-off': { label: 'qwen3.8 thinking OFF (reasoning meta, no reasoning option), baseline 40960, choice null', modelId: 'qwen3.8:27b-mlx', reasoningMeta: true, baseline: 40960, choice: null },
  'qwen-off-nometa': { label: 'qwen3.8 no reasoning meta (old state), choice null', modelId: 'qwen3.8:27b-mlx', choice: null },
  'qwen-on': { label: 'qwen3.8 thinking ON low, baseline 40960, choice 32768 (below baseline)', modelId: 'qwen3.8:27b-mlx', reasoningMeta: true, baseline: 40960, choice: 32768, reasoning: 'low' },
  'qwen-unknown': { label: 'qwen3.8 NO baseline configured, choice 65536', modelId: 'qwen3.8:27b-mlx', reasoningMeta: true, choice: 65536 },
  'gemma12-below': { label: 'gemma4:12b baseline 40960, choice 32768 (below)', modelId: 'gemma4:12b-mlx', baseline: 40960, choice: 32768 },
  'gemma12-above': { label: 'gemma4:12b baseline 40960, choice 49152 (above)', modelId: 'gemma4:12b-mlx', baseline: 40960, choice: 49152 },
  'gemma12-eco-off': { label: 'gemma4:12b baseline 40960, choice null (Eco off/unchanged)', modelId: 'gemma4:12b-mlx', baseline: 40960, choice: null },
  'gemma31-off': { label: 'gemma4:31b baseline 40960, choice null, thinking off', modelId: 'gemma4:31b-mlx', baseline: 40960, choice: null },
}
for (const c of cases) await run(CASES[c])
