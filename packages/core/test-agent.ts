/**
 * Test script for the Agent Core
 *
 * Usage: npx tsx packages/core/test-agent.ts
 *
 * Requires a valid providers.json in /data/config/ (or DATA_DIR env)
 * with at least one configured provider.
 */

import { initDatabase } from './src/database.js'
import { getActiveProvider, buildModel } from './src/provider-config.js'
import { ensureConfigTemplates } from './src/config.js'
import { getTokenUsage, getToolCalls } from './src/token-logger.js'
import { AgentCore } from './src/agent.js'
import path from 'node:path'
import os from 'node:os'

async function main() {
  console.log('🤖 axiom - Agent Core Test\n')

  // Set up DATA_DIR for local testing if not set
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = path.join(os.homedir(), '.axiom')
    console.log(`ℹ️  DATA_DIR not set, using: ${process.env.DATA_DIR}`)
  }

  // Ensure config templates exist
  ensureConfigTemplates()

  // Load provider config
  const provider = getActiveProvider()
  if (!provider) {
    console.error('❌ No provider configured. Edit providers.json:')
    console.error(`   ${path.join(process.env.DATA_DIR, 'config', 'providers.json')}`)
    console.error('\nExample provider configuration:')
    console.error(JSON.stringify({
      providers: [{
        name: 'openai',
        type: 'openai-completions',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-your-key-here',
        enabledModels: ['gpt-4o-mini'],
      }],
    }, null, 2))
    process.exit(1)
  }

  console.log(`✅ Provider: ${provider.name} (${provider.provider})`)
  console.log(`✅ Model: ${provider.enabledModels?.[0]}`)
  console.log(`✅ Base URL: ${provider.baseUrl}\n`)

  // Build model and init database
  const model = buildModel(provider)
  const dbPath = path.join(process.env.DATA_DIR, 'db', 'axiom.db')
  const db = initDatabase(dbPath)
  console.log(`✅ Database: ${dbPath}\n`)

  // Create agent core
  const agent = new AgentCore({
    model,
    apiKey: provider.apiKey,
    db,
    systemPrompt: 'You are Offtangent, a helpful AI assistant. Keep responses concise.',
  })

  // Send a test message
  const testMessage = 'Hello! What is 2 + 2? Please answer briefly.'
  console.log(`📤 Sending: "${testMessage}"\n`)
  console.log('📥 Response:')
  console.log('─'.repeat(50))

  for await (const chunk of agent.sendMessage('test-user', testMessage)) {
    switch (chunk.type) {
      case 'text':
        process.stdout.write(chunk.text ?? '')
        break
      case 'tool_call_start':
        console.log(`\n🔧 Tool call: ${chunk.toolName}(${JSON.stringify(chunk.toolArgs)})`)
        break
      case 'tool_call_end':
        console.log(`   → Result: ${JSON.stringify(chunk.toolResult)}${chunk.toolIsError ? ' [ERROR]' : ''}`)
        break
      case 'error':
        console.error(`\n❌ Error: ${chunk.error}`)
        break
      case 'done':
        console.log('\n' + '─'.repeat(50))
        break
    }
  }

  // Check token usage in database
  console.log('\n📊 Token Usage (from SQLite):')
  const usage = getTokenUsage(db, { limit: 5 })
  if (usage.length === 0) {
    console.log('   (no token usage recorded)')
  } else {
    for (const u of usage) {
      console.log(`   ${u.provider}/${u.model}: ${u.promptTokens} in / ${u.completionTokens} out = $${u.estimatedCost.toFixed(6)}`)
    }
  }

  // Check tool calls
  const tools = getToolCalls(db, { limit: 5 })
  if (tools.length > 0) {
    console.log('\n🔧 Tool Calls (from SQLite):')
    for (const t of tools) {
      console.log(`   ${t.toolName}: ${t.durationMs}ms`)
    }
  }

  console.log('\n✅ Test complete!')
  db.close()
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
