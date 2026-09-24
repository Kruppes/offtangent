import type { SettingsThinkingLevel } from './contracts/settings.js'

/**
 * Settings that belong to ONE turn and must be gone again afterwards.
 *
 * Both fields exist for the quick capture mode (U10a): the answer to a
 * question asked into a voice puck has to be short, spoken and cheap, while
 * the same persona in the web chat keeps the thinking level and the style the
 * user configured. The runtime is per persona and shared between channels, so
 * neither value may be written into it permanently — the agent applies them
 * around the single stream and restores what was there before.
 *
 * Deliberately NOT part of the model selection: a model override is remembered
 * for the lifetime of a live turn and is visible to the client, these two are
 * prompt-level details nobody needs to see.
 */
export interface TurnRuntimeOverrides {
  /** Reasoning level for this turn only. Omitted = keep the runtime's level. */
  thinkingLevel?: SettingsThinkingLevel
  /**
   * Instruction appended to the prompt of this turn only, never persisted into
   * the strand transcript. Empty or blank = nothing is appended.
   */
  styleHint?: string
}

/** True when the overrides would actually change anything about the turn. */
export function hasTurnRuntimeOverrides(overrides: TurnRuntimeOverrides | null | undefined): boolean {
  if (!overrides) return false
  return overrides.thinkingLevel !== undefined || (overrides.styleHint ?? '').trim() !== ''
}
