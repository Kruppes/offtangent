/**
 * Dev-only live smoke of the connector sub-agent against a real local model.
 * NOT production code and not part of any build: it writes a throwaway
 * DATA_DIR, registers the synthetic mailbox fixture and asks a few questions.
 *
 *   OLLAMA_URL=http://host:11434 LOCAL_MODEL=<tag> \
 *     npx tsx scripts/dev/connector-sub-agent-smoke.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const baseUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const modelId = process.env.LOCAL_MODEL ?? 'qwen3.8:27b-mlx'
const providerId = 'smoke-box'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-connector-smoke-'))
process.env.DATA_DIR = dataDir
process.env.ENCRYPTION_KEY = '0'.repeat(64)
fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
fs.writeFileSync(
  path.join(dataDir, 'config', 'providers.json'),
  JSON.stringify({
    providers: [{
      id: providerId,
      name: 'Smoke Box',
      // `type` (wire api) and `provider` (pi-ai provider name) are what
      // buildModel() puts into the Model; a provider row created through the
      // UI preset always carries them, so the fixture must too.
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
  JSON.stringify({ connectors: { localModel: { providerId, modelId } } }, null, 2),
)

const { refreshOllamaTags } = await import('../../packages/core/src/ollama-tag-cache.js')
const { createMailboxConnectorManifest } = await import('../../packages/core/src/connectors/mailbox.fixture.js')
const { getConnectorRegistry } = await import('../../packages/core/src/connectors/registry.js')
const { setConnectorClient, saveConnectorTokens } = await import('../../packages/core/src/connectors/store.js')
const { runConnectorSubAgent } = await import('../../packages/core/src/connectors/sub-agent.js')
const { isStrictlyLocalModel } = await import('../../packages/core/src/data-policy.js')

const stored = await refreshOllamaTags({ providerId, baseUrl, timeoutMs: 5_000 })
console.log(`tags: ${stored} models cached from ${baseUrl}`)
console.log(`isStrictlyLocalModel(${providerId}, ${modelId}) = ${isStrictlyLocalModel(providerId, modelId)}`)

const manifest = createMailboxConnectorManifest()
getConnectorRegistry().register(manifest)
setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
saveConnectorTokens(manifest.id, {
  accessToken: 'access-token-klmnopqrst',
  refreshToken: 'refresh-token-abcdefghij',
  expiresAt: Date.now() + 3_600_000,
  scopes: manifest.oauth?.scopes ?? [],
})

const questions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  'Welche Mails hat Alice geschickt?',
  'Wann ist die Rechnung fällig?',
  'Worum geht es in der Mail von Bob?',
  'Gibt es eine Mail über das Treffen am Donnerstag?',
  'Fasse alle Mails in einem Satz zusammen.',
]

for (const question of questions) {
  const started = Date.now()
  const result = await runConnectorSubAgent(manifest.id, question, { timeoutMs: 120_000 })
  const ms = Date.now() - started
  console.log('─'.repeat(60))
  console.log(`Q: ${question}`)
  console.log(`ok=${result.ok} toolCalls=${result.toolCalls} ms=${ms} error=${result.error ?? '-'}`)
  console.log(`A: ${(result.ok ? result.answer : result.message ?? '').slice(0, 600)}`)
}

fs.rmSync(dataDir, { recursive: true, force: true })
