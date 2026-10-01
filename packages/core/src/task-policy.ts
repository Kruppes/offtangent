/**
 * task-policy.ts: deterministic model + thinking choice for `create_task`.
 *
 * The orchestrator (the strand's agent) already decides to delegate; it knows
 * best what kind of work it hands off. Instead of a second LLM "router" call,
 * `create_task` takes a tiny structured profile:
 *
 *   task_kind:  extraction | research | review | coding | ops | general
 *   difficulty: low | medium | high          (difficulty and risk in one)
 *
 * and this module maps it — by table lookup, no scoring, no prompt parsing —
 * onto a model tier of the provider FAMILY the task runs in, plus a thinking
 * level. The provider stays the one the task would have run on anyway
 * (explicit pin > parent task > the strand of the calling turn > the default
 * chain); the strand's provider is the tie-breaker, never overridden here.
 *
 * Hard rules:
 *  - An explicit model always wins. An explicit provider wins the provider;
 *    with a profile the tier model is picked inside that provider.
 *  - `xhigh` is never chosen automatically. The highest automatic level is
 *    `high`; `xhigh` must be requested explicitly with a `model_reason`.
 *  - Exception models (the top "astra"/"fable" lines) are never chosen
 *    automatically and an explicit pin needs a `model_reason`.
 *  - An automatically chosen model must be enabled on its provider and pass
 *    the data-policy gate. Otherwise the call fails with a clear error — the
 *    policy never switches provider or model on its own. Single exception:
 *    a call WITHOUT any profile whose strand fallback cannot be served keeps
 *    the pre-policy default chain (recorded in `routing.reason`).
 *  - Explicit pins are not run through the automatic-choice gate (they are a
 *    deliberate choice, same as before this policy); they still pass the
 *    enabled-model guard of `resolveProviderModelInput`.
 *
 * Everything that touches config (provider lookup, gate) is injected, so the
 * whole resolution is unit-testable without providers.json.
 */
import type { ProviderConfig } from './provider-config.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { SETTINGS_THINKING_LEVELS } from './contracts/settings.js'

export const TASK_POLICY_KINDS = ['extraction', 'research', 'review', 'coding', 'ops', 'general'] as const
export type TaskPolicyKind = (typeof TASK_POLICY_KINDS)[number]

export const TASK_POLICY_DIFFICULTIES = ['low', 'medium', 'high'] as const
export type TaskPolicyDifficulty = (typeof TASK_POLICY_DIFFICULTIES)[number]

export type TaskPolicyTier = 'light' | 'standard' | 'strong'
export type TaskModelFamily = 'anthropic' | 'openai'

/** Thinking levels the policy may choose on its own. `xhigh` is not one of them. */
export type AutomaticThinkingLevel = Exclude<SettingsThinkingLevel, 'xhigh'>

export interface TaskPolicyCell {
  tier: TaskPolicyTier
  thinking: AutomaticThinkingLevel
}

/**
 * Kind × difficulty → tier + thinking. Mirrors the routing guideline:
 * bounded, checkable extraction runs light; research/review standard and
 * strong only when hard or risky; multi-file coding and autonomous ops go
 * strong from medium on. Thinking scales with difficulty and stops at `high`.
 */
export const TASK_POLICY_MATRIX: Readonly<Record<TaskPolicyKind, Readonly<Record<TaskPolicyDifficulty, TaskPolicyCell>>>> = {
  extraction: {
    low: { tier: 'light', thinking: 'off' },
    medium: { tier: 'light', thinking: 'minimal' },
    high: { tier: 'standard', thinking: 'low' },
  },
  research: {
    low: { tier: 'standard', thinking: 'low' },
    medium: { tier: 'standard', thinking: 'medium' },
    high: { tier: 'strong', thinking: 'medium' },
  },
  review: {
    low: { tier: 'standard', thinking: 'low' },
    medium: { tier: 'standard', thinking: 'medium' },
    high: { tier: 'strong', thinking: 'high' },
  },
  coding: {
    low: { tier: 'standard', thinking: 'low' },
    medium: { tier: 'strong', thinking: 'medium' },
    high: { tier: 'strong', thinking: 'high' },
  },
  ops: {
    low: { tier: 'light', thinking: 'low' },
    medium: { tier: 'strong', thinking: 'medium' },
    high: { tier: 'strong', thinking: 'high' },
  },
  general: {
    low: { tier: 'light', thinking: 'minimal' },
    medium: { tier: 'standard', thinking: 'low' },
    high: { tier: 'strong', thinking: 'medium' },
  },
}

/** Default when the caller gives no profile at all: thrifty, but capable. */
export const TASK_POLICY_FALLBACK: Readonly<{ kind: TaskPolicyKind; difficulty: TaskPolicyDifficulty }> = {
  kind: 'general',
  difficulty: 'medium',
}

/**
 * Tier → model ids per family, in preference order. Only ids listed here are
 * ever chosen automatically, and only when enabled on the provider.
 */
export const TASK_POLICY_FAMILY_MODELS: Readonly<Record<TaskModelFamily, Readonly<Record<TaskPolicyTier, readonly string[]>>>> = {
  anthropic: {
    light: ['claude-sonnet-5-5'],
    standard: ['claude-sonnet-5-5'],
    strong: ['claude-opus-5-5'],
  },
  openai: {
    light: ['gpt-6-luna'],
    standard: ['gpt-6-sol'],
    strong: ['gpt-6-sol'],
  },
}

/** Provider family the matrix knows, by provider type. `null` = no matrix. */
export function taskModelFamily(provider: Pick<ProviderConfig, 'providerType'> | null | undefined): TaskModelFamily | null {
  switch (provider?.providerType) {
    case 'anthropic':
    case 'anthropic-oauth':
      return 'anthropic'
    case 'openai':
    case 'openai-codex':
      return 'openai'
    default:
      return null
  }
}

/**
 * Exception models: the top lines that are only used on an explicit, reasoned
 * request. Matched on whole id segments, so `gpt-6-astra` and `claude-fable-5-1`
 * hit while an unrelated id that merely contains the letters does not.
 */
export function isTaskPolicyExceptionModel(modelId: string): boolean {
  return /(^|[-_.:/])(astra|fable)([-_.:/]|$)/i.test(modelId)
}

export interface TaskProfile {
  kind: TaskPolicyKind
  difficulty: TaskPolicyDifficulty
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function normalizeEnum<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (v === '') return undefined
  return (allowed as readonly string[]).includes(v) ? (v as T) : null
}

/**
 * Validate the structured profile of a `create_task` call. Neither field set
 * → `null` (no profile). One field set → the other takes its fallback value.
 * Unknown values are the caller's error, never guessed.
 */
export function parseTaskProfile(input: { task_kind?: unknown; difficulty?: unknown }): ParseResult<TaskProfile | null> {
  const kind = normalizeEnum(input.task_kind, TASK_POLICY_KINDS)
  if (kind === null) {
    return { ok: false, error: `task_kind must be one of ${TASK_POLICY_KINDS.join(', ')} (got "${String(input.task_kind)}").` }
  }
  const difficulty = normalizeEnum(input.difficulty, TASK_POLICY_DIFFICULTIES)
  if (difficulty === null) {
    return { ok: false, error: `difficulty must be one of ${TASK_POLICY_DIFFICULTIES.join(', ')} (got "${String(input.difficulty)}").` }
  }
  if (!kind && !difficulty) return { ok: true, value: null }
  return {
    ok: true,
    value: { kind: kind ?? TASK_POLICY_FALLBACK.kind, difficulty: difficulty ?? TASK_POLICY_FALLBACK.difficulty },
  }
}

/** Validate an explicit `thinking` value. */
export function parseExplicitThinking(raw: unknown): ParseResult<SettingsThinkingLevel | null> {
  const level = normalizeEnum(raw, SETTINGS_THINKING_LEVELS)
  if (level === null) {
    return { ok: false, error: `thinking must be one of ${SETTINGS_THINKING_LEVELS.join(', ')} (got "${String(raw)}").` }
  }
  return { ok: true, value: level ?? null }
}

/** Where the task's provider came from. */
export type TaskRoutingSource = 'explicit' | 'explicit_provider' | 'parent' | 'strand' | 'default'

/** Where the task's thinking level came from. `background` = runner setting. */
export type TaskThinkingSource = 'explicit' | 'profile' | 'fallback' | 'background'

/**
 * The persisted, user-visible record of the decision (`tasks.routing`).
 * Plain JSON; never contains prompt text.
 */
export interface TaskRouting {
  source: TaskRoutingSource
  kind: TaskPolicyKind | null
  difficulty: TaskPolicyDifficulty | null
  tier: TaskPolicyTier | null
  family: TaskModelFamily | null
  modelId: string
  thinking: SettingsThinkingLevel | null
  thinkingSource: TaskThinkingSource
  reason: string
  /** The caller's own justification (exception model / xhigh), if given. */
  modelReason?: string
}

export interface StrandModelPinRef {
  providerId: string
  modelId: string
}

export type ExplicitResolution =
  | { ok: true; providerId: string; providerName?: string; modelId: string }
  | { ok: false; error: string }

export interface ResolveTaskPolicyInput {
  explicitProvider?: string
  explicitModel?: string
  explicitThinking?: SettingsThinkingLevel | null
  modelReason?: string
  profile: TaskProfile | null
  /** Provider of the task that is calling `create_task` (ALS), if any. */
  parentProvider?: ProviderConfig | null
  /** Pin of the strand whose turn is calling `create_task`, if any. */
  strandPin?: StrandModelPinRef | null
  /** Resolve a provider by id/name to its FULL config (all enabled models). */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Resolve an explicit (provider, model) pair (enabled-model guard included). */
  resolveExplicit: (input: { provider?: string; model?: string }) => ExplicitResolution
  /**
   * The existing default chain (parent task > persona > task role >
   * defaultProvider > active). Its first tier is the parent task's provider.
   */
  getDefaultProvider: () => ProviderConfig | null
  /** Data-policy gate for an AUTOMATIC choice. */
  checkAutomatic: (provider: ProviderConfig, modelId: string) => { allowed: boolean; reason: string }
}

export type TaskPolicyResolution =
  | {
    ok: true
    /** Provider config to run on; `enabledModels[0]` is the model. */
    provider: ProviderConfig
    modelId: string
    /** Thinking level to persist; `null` = runner's background setting. */
    thinking: SettingsThinkingLevel | null
    routing: TaskRouting
  }
  | { ok: false; error: string }

function pinModel(base: ProviderConfig, modelId: string): ProviderConfig {
  return base.enabledModels?.[0] === modelId ? base : { ...base, enabledModels: [modelId] }
}

function firstModel(p: ProviderConfig): string {
  return p.enabledModels?.[0] ?? ''
}

/**
 * Pick the tier model for `profile` inside `base` (the FULL provider config).
 * Returns an error instead of silently using some other model.
 */
function pickTierModel(
  base: ProviderConfig,
  profile: TaskProfile,
  checkAutomatic: ResolveTaskPolicyInput['checkAutomatic'],
): { ok: true; modelId: string; cell: TaskPolicyCell; family: TaskModelFamily } | { ok: false; error: string } | null {
  const family = taskModelFamily(base)
  if (!family) return null
  const cell = TASK_POLICY_MATRIX[profile.kind][profile.difficulty]
  const candidates = TASK_POLICY_FAMILY_MODELS[family][cell.tier]
  const enabled = new Set(base.enabledModels ?? [])
  const modelId = candidates.find((id) => enabled.has(id))
  if (!modelId) {
    return {
      ok: false,
      error: `Task policy: no model for tier "${cell.tier}" (${profile.kind}/${profile.difficulty}) is enabled on provider "${base.name}" `
        + `(expected one of: ${candidates.join(', ')}). Enable it, or pass provider/model explicitly.`,
    }
  }
  const gate = checkAutomatic(base, modelId)
  if (!gate.allowed) {
    return {
      ok: false,
      error: `Task policy: model "${modelId}" on provider "${base.name}" is blocked by the data policy (${gate.reason}). `
        + 'The task was not started; no other provider is chosen automatically. Pass an allowed provider/model explicitly.',
    }
  }
  return { ok: true, modelId, cell, family }
}

/**
 * Resolve provider, model and thinking level for a `create_task` call.
 * Pure apart from the injected lookups; deterministic for equal inputs.
 */
export function resolveTaskPolicy(input: ResolveTaskPolicyInput): TaskPolicyResolution {
  const { profile } = input
  const reasonText = input.modelReason?.trim() || undefined
  const explicitThinking = input.explicitThinking ?? null

  if (explicitThinking === 'xhigh' && !reasonText) {
    return { ok: false, error: 'thinking "xhigh" is never chosen automatically and needs an explicit model_reason.' }
  }

  // Thinking: explicit > profile > (strand fallback) > background setting.
  const thinkingFor = (cell: TaskPolicyCell | null, fallback: boolean): { thinking: SettingsThinkingLevel | null; source: TaskThinkingSource } => {
    if (explicitThinking) return { thinking: explicitThinking, source: 'explicit' }
    if (cell) return { thinking: cell.thinking, source: fallback ? 'fallback' : 'profile' }
    return { thinking: null, source: 'background' }
  }

  const done = (
    provider: ProviderConfig,
    source: TaskRoutingSource,
    cell: TaskPolicyCell | null,
    usedProfile: TaskProfile | null,
    fallbackProfile: boolean,
    reason: string,
  ): TaskPolicyResolution => {
    const modelId = firstModel(provider)
    const t = thinkingFor(cell, fallbackProfile)
    return {
      ok: true,
      provider,
      modelId,
      thinking: t.thinking,
      routing: {
        source,
        kind: usedProfile?.kind ?? null,
        difficulty: usedProfile?.difficulty ?? null,
        tier: cell?.tier ?? null,
        family: taskModelFamily(provider),
        modelId,
        thinking: t.thinking,
        thinkingSource: t.source,
        reason,
        ...(reasonText ? { modelReason: reasonText } : {}),
      },
    }
  }

  // 1. Explicit model (with or without provider): the pin wins.
  if (input.explicitModel) {
    const resolved = input.resolveExplicit({ provider: input.explicitProvider, model: input.explicitModel })
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const base = input.resolveProvider(resolved.providerId)
    if (!base) return { ok: false, error: `Provider "${resolved.providerName ?? resolved.providerId}" could not be loaded.` }
    if (isTaskPolicyExceptionModel(resolved.modelId) && !reasonText) {
      return {
        ok: false,
        error: `Model "${resolved.modelId}" is an exception model and is only used with an explicit model_reason `
          + '(why this task needs it). Pick a regular model or give the reason.',
      }
    }
    const cell = profile ? TASK_POLICY_MATRIX[profile.kind][profile.difficulty] : null
    return done(pinModel(base, resolved.modelId), 'explicit', cell, profile, false,
      'explicit model pin')
  }

  // 2. Explicit provider only: provider wins, the profile picks the tier model.
  if (input.explicitProvider) {
    const resolved = input.resolveExplicit({ provider: input.explicitProvider })
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const base = input.resolveProvider(resolved.providerId)
    if (!base) return { ok: false, error: `Provider "${resolved.providerName ?? resolved.providerId}" could not be loaded.` }
    // The provider's own default model is used unless a tier model is picked;
    // an exception model there needs the same justification as a model pin.
    const exceptionDefault = isTaskPolicyExceptionModel(firstModel(base)) && !reasonText
      ? {
        ok: false as const,
        error: `Provider "${base.name}" defaults to the exception model "${firstModel(base)}", which is only used with an `
          + 'explicit model_reason. Pin a regular model of that provider, or give the reason.',
      }
      : null
    if (profile) {
      const pick = pickTierModel(base, profile, input.checkAutomatic)
      if (pick && !pick.ok) return pick
      if (pick) {
        return done(pinModel(base, pick.modelId), 'explicit_provider', pick.cell, profile, false,
          `explicit provider; ${profile.kind}/${profile.difficulty} → ${pick.cell.tier}`)
      }
      if (exceptionDefault) return exceptionDefault
      return done(base, 'explicit_provider', TASK_POLICY_MATRIX[profile.kind][profile.difficulty], profile, false,
        'explicit provider without policy matrix; provider default model kept')
    }
    if (exceptionDefault) return exceptionDefault
    return done(base, 'explicit_provider', null, null, false, 'explicit provider pin')
  }

  // 3. Parent task: a sub-task stays on its parent's provider (no cross-talk).
  // The default chain owns parent inheritance (its first tier is the parent
  // task's provider from the task execution context), so it is asked here
  // too; `parentProvider` only decides that this is the parent case.
  if (input.parentProvider) {
    const parent = input.getDefaultProvider()
    if (!parent) {
      return { ok: false, error: 'No default task provider is configured. Set one in Settings → Tasks, or pass an explicit provider/model.' }
    }
    if (profile) {
      const full = input.resolveProvider(parent.id) ?? parent
      const pick = pickTierModel(full, profile, input.checkAutomatic)
      if (pick && !pick.ok) return pick
      if (pick) {
        return done(pinModel(full, pick.modelId), 'parent', pick.cell, profile, false,
          `parent task provider; ${profile.kind}/${profile.difficulty} → ${pick.cell.tier}`)
      }
      return done(parent, 'parent', TASK_POLICY_MATRIX[profile.kind][profile.difficulty], profile, false,
        'parent task provider without policy matrix; parent model kept')
    }
    return done(parent, 'parent', null, null, false, 'inherited parent task model')
  }

  // 4. Strand of the calling turn: its provider is the tie-breaker.
  let strandNote = ''
  if (input.strandPin) {
    const full = input.resolveProvider(input.strandPin.providerId)
    if (!full) {
      strandNote = 'strand provider not resolvable; '
    } else if (!taskModelFamily(full)) {
      strandNote = `strand provider "${full.name}" has no policy matrix; `
    } else {
      const fallback = !profile
      const used = profile ?? { ...TASK_POLICY_FALLBACK }
      const pick = pickTierModel(full, used, input.checkAutomatic)
      if (pick && !pick.ok) {
        // An explicit profile that cannot be served is the caller's error.
        // Without a profile the caller asked for nothing specific: the call
        // keeps today's default chain, and the routing record says why.
        if (!fallback) return pick
        strandNote = `strand fallback unavailable (${pick.error}); `
      } else if (pick) {
        return done(pinModel(full, pick.modelId), 'strand', pick.cell, used, fallback,
          `strand provider "${full.name}"; ${used.kind}/${used.difficulty}${fallback ? ' (fallback, no profile given)' : ''} → ${pick.cell.tier}`)
      }
    }
  }

  // 5. Existing default chain (persona > task role > defaultProvider > active).
  const def = input.getDefaultProvider()
  if (!def) {
    return { ok: false, error: 'No default task provider is configured. Set one in Settings → Tasks, or pass an explicit provider/model.' }
  }
  if (profile) {
    const full = input.resolveProvider(def.id) ?? def
    const pick = pickTierModel(full, profile, input.checkAutomatic)
    if (pick && !pick.ok) return pick
    if (pick) {
      return done(pinModel(full, pick.modelId), 'default', pick.cell, profile, false,
        `${strandNote}default task provider; ${profile.kind}/${profile.difficulty} → ${pick.cell.tier}`)
    }
    return done(def, 'default', TASK_POLICY_MATRIX[profile.kind][profile.difficulty], profile, false,
      `${strandNote}default task provider without policy matrix; default model kept`)
  }
  return done(def, 'default', null, null, false, `${strandNote}default task model`)
}

/** Serialize the routing record for `tasks.routing`. */
export function serializeTaskRouting(routing: TaskRouting): string {
  return JSON.stringify(routing)
}

/** Parse `tasks.routing`; tolerant (legacy rows, broken JSON → null). */
export function parseTaskRouting(raw: string | null | undefined): TaskRouting | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as TaskRouting) : null
  } catch {
    return null
  }
}

/** One line for tool results and notifications. */
export function formatTaskRouting(routing: TaskRouting): string {
  const profile = routing.kind ? `${routing.kind}/${routing.difficulty}` : 'no profile'
  return `${routing.modelId} · thinking ${routing.thinking ?? 'background default'} · ${profile} · ${routing.reason}`
}
