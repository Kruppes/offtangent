/**
 * `captureSources` of the settings form, cloned from the server settings.
 *
 * The form is what `save()` posts back to PUT /api/settings, so every source
 * of the contract is cloned, including the one this dialog does not edit:
 * `clock` (the clock's voice switch `enabled` and its `styleHint`, companion
 * K1). Dropping it would post a captureSources object without the clock on
 * every save, the same hole `captureModes.assist` had (3109c5c5).
 */
import type { CaptureSourcesSettings } from '~/composables/useSettings'

export function cloneCaptureSources(sources: CaptureSourcesSettings): CaptureSourcesSettings {
  return { puck: { ...sources.puck }, clock: { ...sources.clock } }
}
