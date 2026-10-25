/**
 * The trigger side of the strand auto-title (plan strand-titel, Paket 5).
 *
 * Same two hooks as the project assignment: the end of every chat turn and
 * the end of a session (which runs right after the session summary, so a
 * fresh summary version is seen there). Both places have already served the
 * user. The gate is a handful of indexed reads, the model call runs in a
 * detached promise, and nothing here is ever awaited by a turn. An Ollama
 * outage ends as a logged `error` outcome, never as an exception.
 *
 * No push frame: clients pick the new title up with the next strand list /
 * detail fetch (the web client has no handler for strand frames yet either).
 */
import { errorClass, evaluateStrandAutoTitle, loadConfig, planStrandAutoTitle } from '@axiom/core'
import type { AutoTitleResult, AutoTitleTrigger, Database } from '@axiom/core'

export interface AutoTitleSettings {
  /** Kill switch (`settings.json` → `autoTitle.enabled`, default on). */
  enabled: boolean
}

const DEFAULT_AUTO_TITLE_SETTINGS: AutoTitleSettings = { enabled: true }

export interface AutoTitleDeps {
  loadSettings: () => { autoTitle?: Partial<AutoTitleSettings> }
  evaluate: typeof evaluateStrandAutoTitle
  console: Pick<typeof console, 'log' | 'warn' | 'error'>
}

const defaultDeps: AutoTitleDeps = {
  loadSettings: () => loadConfig<{ autoTitle?: Partial<AutoTitleSettings> }>('settings.json'),
  evaluate: evaluateStrandAutoTitle,
  console,
}

export function getAutoTitleSettings(loadSettings: AutoTitleDeps['loadSettings'] = defaultDeps.loadSettings): AutoTitleSettings {
  try {
    const raw = loadSettings().autoTitle ?? {}
    return { enabled: raw.enabled !== false }
  } catch {
    return { ...DEFAULT_AUTO_TITLE_SETTINGS }
  }
}

/** Strands with a running evaluation; a turn end and a session end can coincide. */
const inFlight = new Set<string>()

/** Test hook: forget which strands are considered in flight. */
export function resetAutoTitleInFlight(): void {
  inFlight.clear()
}

export interface TriggerAutoTitleOptions {
  db: Database
  sessionId: string
  trigger: AutoTitleTrigger
  /** Resolved after the run so a test can await it. */
  onSettled?: (result: AutoTitleResult) => void
  deps?: Partial<AutoTitleDeps>
}

/**
 * Evaluate one strand's title in the background. Returns synchronously:
 * `true` when a run was started, `false` when it was switched off or the gate
 * refused it. Never throws.
 */
export function triggerStrandAutoTitle(options: TriggerAutoTitleOptions): boolean {
  const { db, sessionId, trigger } = options
  const deps = { ...defaultDeps, ...(options.deps ?? {}) }
  if (!getAutoTitleSettings(deps.loadSettings).enabled) return false
  if (inFlight.has(sessionId)) return false

  let plan: ReturnType<typeof planStrandAutoTitle>
  try {
    plan = planStrandAutoTitle(db, sessionId, trigger)
  } catch (err) {
    deps.console.warn(`[auto-title] Gate failed for strand ${sessionId}: ${errorClass(err)}`)
    return false
  }
  if (!plan.run) return false

  inFlight.add(sessionId)
  void (async () => {
    try {
      const result = await deps.evaluate(db, sessionId, trigger)
      if (result.outcome === 'changed') {
        // Strand id, title length and source only: the title is model output
        // and can quote a phrase of the dictation (review K0-K2-4 #1).
        deps.console.log(`[auto-title] Strand ${sessionId}: renamed (title length ${(result.title ?? '').length}, ${result.model}, trigger ${trigger})`)
      } else if (result.outcome === 'error') {
        deps.console.warn(`[auto-title] Strand ${sessionId}: no title (${(result.notes ?? []).join('; ')})`)
      }
      options.onSettled?.(result)
    } catch (err) {
      // Class only, never the Error object: its message and stack can carry
      // a provider echo of the strand's turns (review K0-K2-3 #1).
      deps.console.error(`[auto-title] Failed for strand ${sessionId}: ${errorClass(err)}`)
    } finally {
      inFlight.delete(sessionId)
    }
  })()
  return true
}
