/**
 * prompt-cache.ts: provider prompt-cache controls (token audit 2026-09-17, §2).
 *
 * Findings the audit left us with:
 * - Only 3 cache breakpoints are in play (all of them set by pi-ai: end of the
 *   system prompt, last tool definition, last user message). Anthropic allows 4.
 * - The system prompt is assembled as ONE string, so its single breakpoint sits
 *   at the very end. Anthropic builds its cache prefix as `tools → system →
 *   messages`, which means any change inside the system prompt (a write into
 *   today's daily file, a MEMORY.md edit, a new wiki page) invalidates the
 *   whole system prompt *and* the whole message history — ~24-26k tokens of
 *   re-write, triggered by the agent's own tool calls mid-session.
 * - `cacheRetention` was never passed, so pi-ai defaulted to `"short"` (5 min).
 *
 * This module adds the missing breakpoint without touching pi-ai: the system
 * prompt carries an invisible marker between its stable prefix and its volatile
 * tail (see `assembleSystemPrompt`), `buildStreamFn` strips that marker from the
 * text it sends and, for Anthropic-API models only, splits the resulting system
 * block in two via pi-ai's `onPayload` hook so the stable prefix gets its own
 * `cache_control`.
 *
 * Everything here is a no-op for non-Anthropic providers (Ollama & friends):
 * the marker is removed for every provider, and nothing else is touched.
 */

import { loadConfig } from './config.js'

/**
 * Invisible boundary between the stable system-prompt prefix and the volatile
 * tail. It is an HTML comment so a leak (a code path that bypasses
 * `buildStreamFn`) is harmless rather than confusing, and it is stripped
 * together with its trailing section separator, which makes the transmitted
 * prompt byte-identical to the unmarked assembly.
 */
export const SYSTEM_PROMPT_CACHE_MARKER = '<!-- cache-breakpoint -->'

/** Section separator used by `assembleSystemPrompt` (`sections.join`). */
const SECTION_SEPARATOR = '\n\n'

export type PromptCacheRetention = 'none' | 'short' | 'long'

export interface PromptCacheSettings {
  /**
   * Cache retention passed to pi-ai for Anthropic-API models. `'long'` asks for
   * the 1h TTL, `'short'` is pi-ai's 5 min default, `'none'` disables caching.
   */
  retention: PromptCacheRetention
  /**
   * Whether to split the system prompt at the marker so the stable prefix keeps
   * its own cache entry when the volatile tail changes.
   */
  systemBreakpoint: boolean
  /**
   * Whether to pass the strand/task session id to the provider for cache
   * routing (`options.sessionId`). Only providers that declare session
   * affinity act on it; for api.anthropic.com it is inert.
   */
  sessionAffinity: boolean
}

export const DEFAULT_PROMPT_CACHE_SETTINGS: PromptCacheSettings = {
  retention: 'long',
  systemBreakpoint: true,
  sessionAffinity: true,
}

function isRetention(value: unknown): value is PromptCacheRetention {
  return value === 'none' || value === 'short' || value === 'long'
}

/** Merge a raw settings block over the defaults. Invalid values are ignored. */
export function resolvePromptCacheSettings(raw: unknown): PromptCacheSettings {
  const out = { ...DEFAULT_PROMPT_CACHE_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  if (isRetention(obj.retention)) out.retention = obj.retention
  if (typeof obj.systemBreakpoint === 'boolean') out.systemBreakpoint = obj.systemBreakpoint
  if (typeof obj.sessionAffinity === 'boolean') out.sessionAffinity = obj.sessionAffinity
  return out
}

/** Read `settings.json` → `promptCache`, falling back to the defaults. */
export function loadPromptCacheSettings(): PromptCacheSettings {
  try {
    const settings = loadConfig<{ promptCache?: unknown }>('settings.json')
    return resolvePromptCacheSettings(settings.promptCache)
  } catch {
    return { ...DEFAULT_PROMPT_CACHE_SETTINGS }
  }
}

export interface SystemPromptSplit {
  /** The prompt with the marker (and its section separator) removed. */
  text: string
  /**
   * Number of characters of `text` that form the stable prefix, or `null` when
   * the prompt carries no marker (task prompts, overrides, tests).
   */
  prefixChars: number | null
}

/**
 * Remove the cache marker and report where the stable prefix ends.
 *
 * `A\n\n<!-- cache-breakpoint -->\n\nB` → text `A\n\nB`, prefix `A\n\n`.
 * The returned text is identical to an assembly that never inserted a marker.
 */
export function splitSystemPromptAtCacheMarker(prompt: string | undefined): SystemPromptSplit {
  if (!prompt) return { text: prompt ?? '', prefixChars: null }
  const index = prompt.indexOf(SYSTEM_PROMPT_CACHE_MARKER)
  if (index < 0) return { text: prompt, prefixChars: null }

  const prefix = prompt.slice(0, index)
  let rest = prompt.slice(index + SYSTEM_PROMPT_CACHE_MARKER.length)
  if (rest.startsWith(SECTION_SEPARATOR)) rest = rest.slice(SECTION_SEPARATOR.length)

  // A marker at the very start or end carries no prefix worth caching.
  if (prefix.length === 0 || rest.length === 0) return { text: prefix + rest, prefixChars: null }
  return { text: prefix + rest, prefixChars: prefix.length }
}

interface AnthropicTextBlock {
  type?: string
  text?: unknown
  cache_control?: unknown
  [key: string]: unknown
}

/**
 * Split the Anthropic system block at `prefixChars` and give the first half its
 * own `cache_control`, so a change in the volatile tail no longer invalidates
 * the cached prefix.
 *
 * The total number of `cache_control` markers stays within Anthropic's limit of
 * 4: any other system block (the Claude Code identity block pi-ai prepends for
 * OAuth tokens) loses its marker, because the new prefix breakpoint sits behind
 * it and already covers it.
 *
 * Returns `undefined` when the payload does not look the way we expect — the
 * caller then sends the original payload unchanged (fail open).
 */
export function applySystemPromptCacheBreakpoint(
  payload: unknown,
  prefixChars: number,
  expectedLength: number,
): unknown | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const params = payload as { system?: unknown }
  const system = params.system
  if (!Array.isArray(system) || system.length === 0) return undefined

  const last = system[system.length - 1] as AnthropicTextBlock | undefined
  if (!last || typeof last !== 'object') return undefined
  if (last.type !== undefined && last.type !== 'text') return undefined
  const text = last.text
  if (typeof text !== 'string') return undefined

  // The prefix offset was computed on the assembled prompt. If the provider
  // layer rewrote the text (pi-ai sanitizes lone surrogates), the offset is no
  // longer trustworthy — bail out instead of cutting in the wrong place.
  if (text.length !== expectedLength) return undefined
  if (prefixChars <= 0 || prefixChars >= text.length) return undefined

  const cacheControl = last.cache_control
  // No cache_control means caching is off (retention "none") — nothing to do.
  if (cacheControl === undefined || cacheControl === null) return undefined

  const head = system.slice(0, -1).map(block => {
    if (!block || typeof block !== 'object') return block
    const { cache_control: _dropped, ...rest } = block as AnthropicTextBlock
    return rest
  })

  const prefixBlock: AnthropicTextBlock = {
    ...last,
    text: text.slice(0, prefixChars),
    cache_control: cacheControl,
  }
  const tailBlock: AnthropicTextBlock = {
    ...last,
    text: text.slice(prefixChars),
    cache_control: cacheControl,
  }

  return { ...(payload as Record<string, unknown>), system: [...head, prefixBlock, tailBlock] }
}

/** Whether a model speaks the Anthropic Messages API (the only cached path). */
export function isAnthropicMessagesApi(api: unknown): boolean {
  return api === 'anthropic-messages'
}
