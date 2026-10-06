import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import { completeSimple } from './pi-models.js'
import { loadPersona, getPersonaDir } from './persona-loader.js'
// resolveBackgroundReasoning import removed — cross-persona calls explicitly disable reasoning
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { archivedPersonaIds, defaultPersonaId, formatPersonaDirectoryLine, listPersonaDirectory } from './persona-directory.js'
import { recordPersonaDelegation } from './persona-delegation-log.js'
import { getMemoryDir, resolveAgentMemoryDir } from './memory.js'
import { sealSystemText } from './secret-boundary.js'

/** Maximum cross-agent call depth */
const MAX_CALL_DEPTH = 3

/** Size cap for the target persona's MEMORY.md with `include_core_memory` (UTF-8 bytes). */
export const ASK_AGENT_CORE_MEMORY_MAX_BYTES = 25 * 1024

/** Machine-readable label of an ask_agent answer (plan persona-architektur 1c). */
export const ASK_AGENT_JUDGMENT_PLAIN = 'Persona-Urteil ohne Gedächtnis und ohne Werkzeuge'
export const ASK_AGENT_JUDGMENT_CORE_MEMORY = 'Persona-Urteil mit Kern-Gedächtnis (MEMORY.md), ohne Werkzeuge'

export interface AskAgentToolOptions {
  /** The agentId of the calling agent (to prevent self-queries) */
  getCurrentAgentId: () => string
  /** Provides the LLM model for the nested call */
  getModel: () => Model<Api>
  /**
   * Provides the API key for the nested call.
   *
   * MUST be async-capable: for OAuth-authenticated providers (e.g. Claude Pro)
   * the token must be freshly resolved on every call to handle refresh flows.
   * Returning a stale/empty key produces silent auth failures that surface as
   * empty responses, which is very hard to diagnose.
   */
  getApiKey: () => string | Promise<string>
  /** Current call chain for recursion detection */
  callChain?: string[]
  /**
   * Database for the delegation protocol (`persona_delegations`) and the
   * archived flag of personas. Optional: without it nothing is logged and
   * archived personas are not filtered (tests, legacy callers).
   */
  db?: Database | null
  /**
   * Memory root of a persona for `include_core_memory`. Defaults to the
   * scoped persona memory (`/data/agents/<id>/memory`) or, for `main` and
   * non-scoped installs, the global memory dir.
   */
  resolveMemoryDir?: (agentId: string) => string | undefined
}

function defaultResolveMemoryDir(agentId: string): string | undefined {
  return resolveAgentMemoryDir(agentId, { fallbackMemoryDir: getMemoryDir() })
}

/**
 * Read a persona's MEMORY.md for `include_core_memory`: capped to
 * `ASK_AGENT_CORE_MEMORY_MAX_BYTES` (cut at a line break when possible) and
 * sealed by the same secret boundary as the system prompt. Null when missing
 * or empty.
 */
export function readCoreMemoryForAskAgent(memoryDir: string | undefined, agentId: string): { text: string; truncated: boolean } | null {
  if (!memoryDir) return null
  let raw: string
  try {
    raw = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8')
  } catch {
    return null
  }
  if (!raw.trim()) return null
  let text = raw
  let truncated = false
  const buf = Buffer.from(raw, 'utf-8')
  if (buf.length > ASK_AGENT_CORE_MEMORY_MAX_BYTES) {
    // Decode the cut prefix; a split multi-byte char at the end becomes U+FFFD and is dropped.
    let cut = buf.subarray(0, ASK_AGENT_CORE_MEMORY_MAX_BYTES).toString('utf-8').replace(/\uFFFD+$/, '')
    const lastBreak = cut.lastIndexOf('\n')
    if (lastBreak > ASK_AGENT_CORE_MEMORY_MAX_BYTES / 2) cut = cut.slice(0, lastBreak)
    text = `${cut}\n[… MEMORY.md truncated at ${ASK_AGENT_CORE_MEMORY_MAX_BYTES / 1024} KB]`
    truncated = true
  }
  return { text: sealSystemText(text, `ask_agent-memory:${agentId}`), truncated }
}

/**
 * Frame an ask_agent answer so the calling model passes it on verbatim
 * instead of paraphrasing it ("Stille Post"). The answer stays byte-exact
 * inside the frame; only a literal closing tag inside it is defused.
 */
export function formatAskAgentAnswer(input: { targetAgentId: string; answer: string; coreMemory: boolean }): string {
  const label = input.coreMemory ? ASK_AGENT_JUDGMENT_CORE_MEMORY : ASK_AGENT_JUDGMENT_PLAIN
  const body = input.answer.replace(/<\/persona_answer>/gi, '<\\/persona_answer>')
  return [
    `<persona_answer persona="${input.targetAgentId}" memory="${input.coreMemory ? 'core' : 'none'}" tools="none" verbatim="true">`,
    `Hinweis: ${label}.`,
    `Instruction for you (the calling agent): pass this answer on as a verbatim quote attributed to "${input.targetAgentId}" — do not paraphrase, shorten or merge it into your own words. Mark it as a ${input.coreMemory ? 'judgment with core memory only (no live data, no tools)' : 'judgment without memory and without tools'}. Your own assessment, if any, comes separately after the quote.`,
    '<answer>',
    body,
    '</answer>',
    '</persona_answer>',
  ].join('\n')
}

/**
 * List all available agent IDs by scanning /data/agents/ directories.
 * Always includes 'main' as the default agent.
 */
export function listAvailableAgents(baseDir?: string): string[] {
  const dataDir = baseDir ?? path.join(process.env.DATA_DIR ?? '/data', 'agents')
  const agents: string[] = ['main']

  try {
    if (!fs.existsSync(dataDir)) return agents

    const entries = fs.readdirSync(dataDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'main') {
        agents.push(entry.name)
      }
    }
  } catch {
    // Directory not readable, return just main
  }

  return agents
}

/**
 * The `<cross_persona>` system-prompt block (plan persona-architektur 1c):
 * one line per other active persona (id, badge, name, one-line role, up to
 * six subjects from IDENTITY.md), archived personas left out. Deterministic
 * — `main` first, the rest sorted by id, nothing time-dependent — so the
 * block is byte-stable between turns and does not break the prompt cache.
 * The default persona additionally learns how to delegate a task.
 */
export function buildAskAgentPromptHint(currentAgentId: string, baseDir?: string, db?: Database | null): string {
  const others = listPersonaDirectory({ baseDir, db }).filter(entry => entry.id !== currentAgentId)
  if (others.length === 0) return ''

  const lines = [
    '',
    '',
    '<cross_persona>',
    'Other personas (id, badge, name: role. Subjects):',
    ...others.map(formatPersonaDirectoryLine),
    'ask_agent: a quick one-shot judgment of another persona, without tools and without memory (include_core_memory=true adds its MEMORY.md). Pass the framed answer on verbatim as a quote, never paraphrased.',
  ]
  if (currentAgentId === defaultPersonaId(db)) {
    lines.push('create_task with persona="<id>": the task runs AS that persona (its memory, persona files and model) and its result comes back to you in this strand. Use it for real work in a persona\'s domain.')
  }
  lines.push('</cross_persona>')
  return lines.join('\n')
}

type AskAgentOutcome = { success: boolean; error?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } }

/** One `persona_delegations` row per ask_agent call (plan persona-architektur 1c, point 4). */
function logAskAgentDelegation(db: Database | null | undefined, callerAgentId: string, targetAgentId: string, startedAtMs: number, outcome: AskAgentOutcome): void {
  recordPersonaDelegation(db, {
    callerAgentId,
    targetAgentId,
    kind: 'ask_agent',
    success: outcome.success,
    durationMs: Date.now() - startedAtMs,
    inputTokens: outcome.usage?.input ?? null,
    outputTokens: outcome.usage?.output ?? null,
    costUsd: outcome.usage?.cost?.total ?? null,
    error: outcome.error ?? null,
  })
}

/**
 * Create the ask_agent tool for cross-persona communication.
 *
 * This tool allows one persona to query another persona for its perspective.
 * The target agent responds in character using a stateless, one-shot LLM call.
 * No session is created and no facts are extracted from the response.
 *
 * Guards:
 * - Self-query is forbidden (agent cannot ask itself)
 * - Maximum call depth of 3 to prevent infinite recursion
 * - Feature is only available when multiPersona is enabled
 */
export function createAskAgentTool(options: AskAgentToolOptions): AgentTool {
  const { getCurrentAgentId, getModel, getApiKey } = options
  const callChain = options.callChain ?? []

  return {
    name: 'ask_agent',
    label: 'Ask Another Agent',
    description:
      'Ask another persona agent a question. Use this when you need another agent\'s perspective, expertise, or opinion. ' +
      'The other agent will respond in character.',
    parameters: Type.Object({
      agent_id: Type.String({
        description: 'ID of the target agent (e.g. \'advisor\', \'researcher\'). Must be a configured agent under /data/agents/<id>/.',
      }),
      question: Type.String({
        description: 'The question or message to send to the target agent. Be clear and specific.',
      }),
      include_core_memory: Type.Optional(Type.Boolean({
        description: 'Load the target persona\'s core memory (its MEMORY.md, max 25 KB) into its prompt. Default false. Still no tools, no live data.',
      })),
    }),
    execute: async (_toolCallId, params) => {
      const { agent_id: targetAgentId, question, include_core_memory } = params as {
        agent_id: string
        question: string
        include_core_memory?: boolean
      }
      const includeCoreMemory = include_core_memory === true

      if (!targetAgentId || typeof targetAgentId !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Error: agent_id is required.' }],
          details: { error: true },
        }
      }

      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: question must be a non-empty string.' }],
          details: { error: true },
        }
      }

      const currentAgentId = getCurrentAgentId()

      // Guard: self-query
      if (targetAgentId === currentAgentId) {
        return {
          content: [{ type: 'text' as const, text: `Error: Cannot ask yourself (agent '${currentAgentId}'). Use ask_agent to query a different persona.` }],
          details: { error: true, reason: 'self_query' },
        }
      }

      // Guard: recursion depth
      const currentChain = [...callChain, currentAgentId]
      if (currentChain.length >= MAX_CALL_DEPTH) {
        return {
          content: [{ type: 'text' as const, text: `Error: Maximum cross-agent call depth (${MAX_CALL_DEPTH}) exceeded. Call chain: ${currentChain.join(' → ')}.` }],
          details: { error: true, reason: 'max_depth', callChain: currentChain },
        }
      }

      // Guard: target in call chain (prevent A→B→A loops)
      if (currentChain.includes(targetAgentId)) {
        return {
          content: [{ type: 'text' as const, text: `Error: Agent '${targetAgentId}' is already in the call chain (${currentChain.join(' → ')}). Circular calls are not allowed.` }],
          details: { error: true, reason: 'circular', callChain: currentChain },
        }
      }

      // A persona must be an actual directory entry beneath agents/, not a
      // path that merely exists after joining (e.g. ../memory). Otherwise
      // include_core_memory can read files outside the persona root.
      if (!listAvailableAgents().includes(targetAgentId)) {
        return {
          content: [{ type: 'text' as const, text: `Error: Agent '${targetAgentId}' is not configured.` }],
          details: { error: true, reason: 'not_found' },
        }
      }

      if (targetAgentId !== 'main' && archivedPersonaIds(options.db).has(targetAgentId)) {
        return {
          content: [{ type: 'text' as const, text: `Error: Agent '${targetAgentId}' is archived and cannot be asked.` }],
          details: { error: true, reason: 'archived' },
        }
      }

      // Load target persona
      const persona = loadPersona(targetAgentId, { skipFeatureCheck: true })

      // Check if persona directory exists
      if (!persona.hasPersonaDir && targetAgentId !== 'main') {
        return {
          content: [{ type: 'text' as const, text: `Error: Agent '${targetAgentId}' is not configured. No persona directory found at ${getPersonaDir(targetAgentId)}.` }],
          details: { error: true, reason: 'not_found' },
        }
      }

      // Build a system prompt for the target agent from its persona files
      const systemPromptParts: string[] = []

      if (persona.soul) {
        systemPromptParts.push(persona.soul)
      } else {
        systemPromptParts.push('You are a helpful AI assistant.')
      }

      if (persona.identity) {
        systemPromptParts.push(persona.identity)
      }

      if (persona.agents) {
        systemPromptParts.push(persona.agents)
      }

      // Optional core memory (plan persona-architektur 1c): the target's
      // MEMORY.md, capped and sealed like the system prompt. Still no tools.
      let coreMemoryLoaded = false
      if (includeCoreMemory) {
        const resolveMemoryDir = options.resolveMemoryDir ?? defaultResolveMemoryDir
        const memoryDir = resolveMemoryDir(targetAgentId)
        const core = readCoreMemoryForAskAgent(memoryDir, targetAgentId)
        if (core) {
          systemPromptParts.push(`<core_memory persona="${targetAgentId}">\n${core.text}\n</core_memory>`)
          coreMemoryLoaded = true
        }
      }

      // Add a context note about cross-agent communication
      systemPromptParts.push(
        `\nYou are being asked a question by another agent (${currentAgentId}). ` +
        'Respond in character, concisely and helpfully. ' +
        'This is a one-shot query — you have no conversation history for this exchange.'
      )

      const systemPrompt = systemPromptParts.join('\n\n')

      console.log(`[ask_agent] ${currentAgentId} → ${targetAgentId}: "${question.slice(0, 100)}${question.length > 100 ? '...' : ''}"`)

      const startedAtMs = Date.now()
      try {
        const model = getModel()
        const apiKey = await getApiKey()

        // Option A: Disable reasoning for cross-persona queries.
        // These are short one-shot calls that don't benefit from extended thinking.
        // Using undefined (= off) keeps the call fast and avoids the bug where
        // reasoning models only fill thinking blocks but no text blocks.
        // Don't pass temperature: some reasoning models (e.g. Claude Opus 4.7) reject it outright.
        // Letting the SDK pick the default keeps us compatible across temperature-sensitive and
        // temperature-rejecting models. For cross-persona calls a slightly deterministic reply
        // is fine — the target persona's SOUL/IDENTITY provides the voice.
        const response = await completeSimple(model, {
          systemPrompt,
          messages: [{
            role: 'user' as const,
            content: question,
            timestamp: Date.now(),
          }],
        }, {
          apiKey,
          reasoning: undefined, // explicitly disabled — no extended thinking for cross-persona calls
        })

        // Surface provider errors directly instead of silently returning "empty response".
        // Without this, auth failures / 400s / rate limits were being masked as empty responses,
        // which made debugging very hard (took a full live-debug session to find an OAuth bug).
        if (response.stopReason === 'error') {
          const errMsg = response.errorMessage || 'unknown provider error'
          console.error(`[ask_agent] provider error for ${targetAgentId}: ${errMsg}`)
          logAskAgentDelegation(options.db, currentAgentId, targetAgentId, startedAtMs, { success: false, error: errMsg, usage: response.usage })
          return {
            content: [{ type: 'text' as const, text: `Error querying agent '${targetAgentId}': ${errMsg}` }],
            details: { error: true, targetAgentId, reason: 'provider_error', errorMessage: errMsg },
          }
        }

        let responseText = response.content
          .filter(item => item.type === 'text')
          .map(item => (item as { type: 'text'; text: string }).text)
          .join('')
          .trim()

        // Option B (safety net): If text is empty but thinking blocks exist,
        // fall back to the thinking content. This can happen if a reasoning model
        // ignores the reasoning=undefined hint and produces only thinking blocks.
        if (!responseText) {
          const thinkingText = response.content
            .filter(item => item.type === 'thinking')
            .map(item => (item as { type: 'thinking'; thinking: string }).thinking)
            .join('')
            .trim()

          if (thinkingText) {
            console.warn(`[ask_agent] ${targetAgentId} returned empty text but has thinking content — using thinking as fallback`)
            responseText = thinkingText
          }
        }

        if (!responseText) {
          logAskAgentDelegation(options.db, currentAgentId, targetAgentId, startedAtMs, { success: false, error: 'empty response', usage: response.usage })
          return {
            content: [{ type: 'text' as const, text: `Agent '${targetAgentId}' returned an empty response.` }],
            details: { targetAgentId, empty: true },
          }
        }

        console.log(`[ask_agent] ${targetAgentId} responded (${responseText.length} chars)`)

        logAskAgentDelegation(options.db, currentAgentId, targetAgentId, startedAtMs, { success: true, usage: response.usage })

        return {
          content: [{ type: 'text' as const, text: formatAskAgentAnswer({ targetAgentId, answer: responseText, coreMemory: coreMemoryLoaded }) }],
          details: {
            targetAgentId,
            verbatim: true,
            coreMemory: coreMemoryLoaded,
            responseLength: responseText.length,
            callChain: [...currentChain, targetAgentId],
          },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        console.error(`[ask_agent] Error querying ${targetAgentId}:`, err)
        logAskAgentDelegation(options.db, currentAgentId, targetAgentId, startedAtMs, { success: false, error: errorMessage })
        return {
          content: [{ type: 'text' as const, text: `Error querying agent '${targetAgentId}': ${errorMessage}` }],
          details: { error: true, targetAgentId },
        }
      }
    },
  }
}
