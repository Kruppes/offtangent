/**
 * Capture mode „Kurzfrage" (U10a): everything the quick path needs before it
 * files anything.
 *
 * Why this is its own module: the service decides WHERE a capture goes, this
 * decides HOW the quick turn is run. The two questions have different failure
 * modes — a missing strand is a bug, a misconfigured model is an installation
 * detail that must degrade instead of throwing a 500 at a voice puck.
 */
import { loadCaptureModeSettings } from '@axiom/core'
import type { Database, ModelSelection, SettingsThinkingLevel, TurnRuntimeOverrides } from '@axiom/core'
import { listSelectableModels } from '../../../model-selection.js'

/** Model value written into `router_decisions.model` for a quick filing. */
export const QUICK_MODE_MODEL = 'quick-mode'

/** Rationale of a quick filing. Names the mode, not a strand choice nobody made. */
export const QUICK_MODE_RATIONALE = 'Kurzfrage-Modus: fixer Strand, kein Router'

export interface QuickModePlan {
  /** Strand title the quick strand is created with / recognized by. */
  strandTitle: string
  /** Model pin for this turn, or undefined to inherit the persona's model. */
  turnOverride: ModelSelection | undefined
  /** Thinking level and style instruction for this single turn. */
  turnOverrides: TurnRuntimeOverrides
  /** Why `turnOverride` is undefined although a pair was configured (log line). */
  modelNote: string | null
}

/**
 * Resolve the quick mode configuration for one capture.
 *
 * The configured provider/model pair is validated against the very catalog
 * `GET /api/models` exposes, the same check an explicit client pin goes
 * through. A pair that is gone (provider deleted, model disabled, test
 * failing) does NOT fail the capture: the mode's promise is a fast answer, so
 * the turn falls back to the persona's own model and the reason is logged.
 */
export function planQuickMode(source: string): QuickModePlan {
  const { captureModes, captureSources } = loadCaptureModeSettings()
  const quick = captureModes.quick

  let turnOverride: ModelSelection | undefined
  let modelNote: string | null = null
  if (quick.providerId && quick.modelId) {
    const available = listSelectableModels().some(model =>
      model.providerId === quick.providerId && model.modelId === quick.modelId && model.selectable)
    if (available) turnOverride = { providerId: quick.providerId, modelId: quick.modelId }
    else modelNote = `configured model ${quick.providerId}:${quick.modelId} is not selectable, falling back to the persona model`
  } else if (quick.providerId || quick.modelId) {
    modelNote = 'captureModes.quick needs both providerId and modelId, falling back to the persona model'
  }

  const hints = [quick.styleHint, styleHintForSource(source, captureSources)]
    .map(hint => hint.trim())
    .filter(hint => hint !== '')

  return {
    strandTitle: quick.strandTitle,
    turnOverride,
    turnOverrides: {
      thinkingLevel: quick.thinkingLevel as SettingsThinkingLevel,
      styleHint: hints.join(' '),
    },
    modelNote,
  }
}

/**
 * The style hint of the device the capture came from. Only sources whose
 * output channel differs from a screen have one; everything else adds nothing.
 */
function styleHintForSource(source: string, captureSources: { puck: { styleHint: string } }): string {
  return source.trim().toLowerCase() === 'puck' ? captureSources.puck.styleHint : ''
}

/**
 * Turn-local overrides a capture gets from its SOURCE alone, i.e. in the
 * normal work mode (U10a point 4).
 *
 * A capture from the puck is answered into a 1.85 inch display and read out
 * loud, no matter which mode it was recorded in. So the device hint applies to
 * a working capture too — but only the hint: the model and the thinking level
 * of a work capture stay exactly what the persona is configured with, because
 * work is where the answer may cost time and depth.
 *
 * Returns undefined when the source has nothing to say, so the caller can keep
 * the turn completely untouched instead of passing an empty override.
 */
export function planSourceStyle(source: string): TurnRuntimeOverrides | undefined {
  const { captureSources } = loadCaptureModeSettings()
  const styleHint = styleHintForSource(source, captureSources).trim()
  return styleHint === '' ? undefined : { styleHint }
}

/**
 * Turn-local overrides of the assist mode (puck assist waves, W1).
 *
 * Assist is the smallest possible mode: it adds ONE style instruction and
 * nothing else. No model pin (the persona's own model writes the draft, a
 * mail is not a place to save tokens), no thinking level, no strand — the
 * router files an assisted capture exactly like a working one.
 *
 * The device hint of the source is appended the same way the quick mode does
 * it, because an assisted capture from the puck is still read out loud on a
 * device without a screen.
 *
 * Returns undefined when both hints are empty, so an installation that has
 * cleared the setting gets a completely untouched turn.
 */
export function planAssistMode(source: string): TurnRuntimeOverrides | undefined {
  const { captureModes, captureSources } = loadCaptureModeSettings()
  const styleHint = [captureModes.assist.styleHint, styleHintForSource(source, captureSources)]
    .map(hint => hint.trim())
    .filter(hint => hint !== '')
    .join(' ')
  return styleHint === '' ? undefined : { styleHint }
}

/**
 * The strand every quick capture of this user and source is answered in, or
 * null when there is none yet.
 *
 * The evidence is `router_decisions.created_strand_id` of an earlier quick
 * filing, which is what the SERVER did, not what a client claims — the same
 * ownership proof `clientCreatedStrand` uses for explicit targeting. That also
 * means the puck may later target this strand by id without tripping the
 * explicit-target guard.
 *
 * Archived or deleted strands are skipped: a user who archives the quick
 * strand has said he is done with it, and the next quick capture opens a fresh
 * one instead of resurrecting it.
 */
export function findQuickStrand(db: Database, userId: string, source: string): string | null {
  const row = db.prepare(
    `SELECT d.created_strand_id AS strandId
       FROM router_decisions d
       JOIN captures c ON c.id = d.capture_id
       JOIN sessions s ON s.id = d.created_strand_id
      WHERE d.model = ?
        AND c.user_id = ?
        AND c.source = ?
        AND d.created_strand_id IS NOT NULL
        AND s.archived = 0
        AND s.type = 'interactive'
      ORDER BY d.created_at DESC
      LIMIT 1`,
  ).get(QUICK_MODE_MODEL, userId, source) as { strandId: string } | undefined
  return row?.strandId ?? null
}
