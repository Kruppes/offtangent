/**
 * Dev-only live smoke of the Google connector against a real local model.
 * NOT production code and not part of any build.
 *
 * The upstream is the FAKE Google of `fake-google.fixture.ts` (synthetic mails
 * and calendar entries, Alice/Bob, example.com) — no real account is touched. The
 * model is real: the point of this script is whether a small local model picks
 * the right tool with the right arguments.
 *
 *   OLLAMA_URL=http://host:11434 LOCAL_MODEL=<tag> \
 *     npx tsx scripts/dev/connector-google-smoke.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const baseUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const modelId = process.env.LOCAL_MODEL ?? 'qwen3.8:27b-mlx'
const providerId = 'smoke-box'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-google-smoke-'))
process.env.DATA_DIR = dataDir
process.env.ENCRYPTION_KEY = '0'.repeat(64)
fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
fs.writeFileSync(
  path.join(dataDir, 'config', 'providers.json'),
  JSON.stringify({
    providers: [{
      id: providerId,
      name: 'Smoke Box',
      type: 'openai-completions',
      providerType: 'ollama',
      provider: 'ollama',
      baseUrl: `${baseUrl.replace(/\/+$/, '')}/v1`,
      apiKey: '',
      enabledModels: [modelId],
      dataPolicy: { region: 'local', training: 'no' },
    }],
    activeProvider: providerId,
    activeModel: modelId,
  }, null, 2),
)
fs.writeFileSync(
  path.join(dataDir, 'config', 'settings.json'),
  JSON.stringify({ timezone: 'Europe/Berlin', connectors: { localModel: { providerId, modelId } } }, null, 2),
)

const { refreshOllamaTags } = await import('../../packages/core/src/ollama-tag-cache.js')
const { createConnectorToolContext } = await import('../../packages/core/src/connectors/access.js')
const { createFakeGoogle } = await import('../../packages/core/src/connectors/google/fake-google.fixture.js')
const { GOOGLE_CONNECTOR_ID, GOOGLE_SCOPES } = await import('../../packages/core/src/connectors/google/manifest.js')
const { getConnectorManifest } = await import('../../packages/core/src/connectors/registry.js')
const { setConnectorClient, saveConnectorTokens } = await import('../../packages/core/src/connectors/store.js')
const { runConnectorSubAgent } = await import('../../packages/core/src/connectors/sub-agent.js')
const { isStrictlyLocalModel } = await import('../../packages/core/src/data-policy.js')

const stored = await refreshOllamaTags({ providerId, baseUrl, timeoutMs: 5_000 })
console.log(`tags: ${stored} models cached from ${baseUrl}`)
console.log(`isStrictlyLocalModel(${providerId}, ${modelId}) = ${isStrictlyLocalModel(providerId, modelId)}`)

const manifest = getConnectorManifest(GOOGLE_CONNECTOR_ID)
if (!manifest) throw new Error('the google connector is not in the registry')

setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
saveConnectorTokens(manifest.id, {
  accessToken: 'access-token-before-refresh',
  refreshToken: 'refresh-token-abcdefghij',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scopes: GOOGLE_SCOPES,
})

const fake = createFakeGoogle()

const questions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  'Welche Mails sind von Alice gekommen?',
  'Welche Termine habe ich am 28.09.2026?',
  'Lies den Thread von Bob über die Rechnung und sag mir das Fälligkeitsdatum.',
  'Habe ich am 29.09.2026 einen ganztägigen Termin?',
  'Gibt es eine Mail über eine Lieferung, und hängt etwas dran?',
]

interface Row {
  question: string
  ok: boolean
  toolCalls: number
  ms: number
  error: string
  answer: string
  apiCalls: number
}
const rows: Row[] = []

for (const question of questions) {
  const apiBefore = fake.apiCalls
  const started = Date.now()
  const result = await runConnectorSubAgent(manifest.id, question, {
    timeoutMs: 180_000,
    buildToolContext: m => createConnectorToolContext(m, { fetchImpl: fake.fetchImpl }),
  })
  const ms = Date.now() - started
  const answer = (result.ok ? result.answer : result.message ?? '').replace(/\s+/g, ' ').trim()
  rows.push({
    question,
    ok: result.ok,
    toolCalls: result.toolCalls,
    ms,
    error: result.error ?? '-',
    answer,
    apiCalls: fake.apiCalls - apiBefore,
  })
  console.log('─'.repeat(70))
  console.log(`Q: ${question}`)
  console.log(`ok=${result.ok} toolCalls=${result.toolCalls} fakeApiCalls=${fake.apiCalls - apiBefore} ms=${ms} error=${result.error ?? '-'}`)
  console.log(`A: ${answer.slice(0, 700)}`)
}

console.log('\n| # | question | tool calls | api calls | ms | ok | answer (shortened) |')
console.log('|---|---|---|---|---|---|---|')
rows.forEach((row, index) => {
  console.log(`| ${index + 1} | ${row.question} | ${row.toolCalls} | ${row.apiCalls} | ${row.ms} | ${row.ok ? 'yes' : `no (${row.error})`} | ${row.answer.slice(0, 160).replace(/\|/g, '/')} |`)
})

fs.rmSync(dataDir, { recursive: true, force: true })
