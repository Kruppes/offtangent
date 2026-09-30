import type { ThinkingLevel as PiAiThinkingLevel } from '@earendil-works/pi-ai'
import { loadConfig } from './config.js'
import { SETTINGS_THINKING_LEVELS } from './contracts/settings.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'

/**
 * Coerce any value into a valid `SettingsThinkingLevel` or `undefined`.
 */
export function normalizeThinkingLevel(value: unknown): SettingsThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  return (SETTINGS_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as SettingsThinkingLevel)
    : undefined
}

/**
 * Map our `SettingsThinkingLevel` onto pi-ai's `reasoning` option.
 * - `off` \u2192 `undefined` (no reasoning)
 * - any other value is passed through
 *
 * pi-ai's `ThinkingLevel` type does NOT include "off"; that's our abstraction.
 */
export function toPiAiReasoning(level: SettingsThinkingLevel | undefined | null): PiAiThinkingLevel | undefined {
  if (!level || level === 'off') return undefined
  return level
}

/**
 * Read the main chat agent's configured thinking level from settings.json.
 * Returns `undefined` when settings are not yet available so callers can
 * fall back to their own defaults.
 */
export function readChatThinkingLevelFromConfig(): SettingsThinkingLevel | undefined {
  try {
    const settings = loadConfig<{ thinkingLevel?: string }>('settings.json')
    return normalizeThinkingLevel(settings.thinkingLevel)
  } catch {
    return undefined
  }
}

/**
 * Read the background-agent thinking level (task runner, fact extraction,
 * memory consolidation, session summaries) from settings.json.
 */
export function readBackgroundThinkingLevelFromConfig(): SettingsThinkingLevel | undefined {
  try {
    const settings = loadConfig<{ tasks?: { backgroundThinkingLevel?: string } }>('settings.json')
    return normalizeThinkingLevel(settings.tasks?.backgroundThinkingLevel)
  } catch {
    return undefined
  }
}

/**
 * Resolve the effective background reasoning value to pass to pi-ai's
 * `completeSimple`/`streamSimple` options. Returns `undefined` when reasoning
 * should be disabled (either explicitly `off` or no setting configured).
 */
export function resolveBackgroundReasoning(): PiAiThinkingLevel | undefined {
  return toPiAiReasoning(readBackgroundThinkingLevelFromConfig() ?? 'off')
}

/**
 * Resolve the effective main-chat reasoning value to pass to pi-ai.
 */
export function resolveChatReasoning(): PiAiThinkingLevel | undefined {
  return toPiAiReasoning(readChatThinkingLevelFromConfig() ?? 'off')
}
