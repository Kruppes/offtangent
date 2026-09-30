import type { ConnectorSetupStepContract } from '@axiom/core/contracts'

/** The two card values a setup step can put on the clipboard. */
export type SetupCopySource = { redirectUri: string; scopes: string[] }

/**
 * The value a step puts on the clipboard, or `''` when there is nothing to
 * copy. Scopes go out one per line: the provider console's manual scope field
 * splits pasted input on line breaks, and a line break survives a paste into a
 * single line field better than a separator the field may not split on.
 */
export function setupStepCopyValue(step: ConnectorSetupStepContract, source: SetupCopySource): string {
  if (step.copy === 'scopes') return source.scopes.join('\n')
  if (step.copy === 'redirectUri') return source.redirectUri
  return ''
}

/**
 * The i18n key of a step's copy button, or `''` when the step offers nothing to
 * copy. A redirect URI step without a configured base URL falls into that case:
 * the card shows the configuration hint instead of a button that would copy an
 * empty string.
 */
export function setupStepCopyLabel(step: ConnectorSetupStepContract, source: SetupCopySource): string {
  if (!setupStepCopyValue(step, source)) return ''
  if (step.copy === 'scopes') return 'connectors.setup.copyScopes'
  if (step.copy === 'redirectUri') return 'connectors.setup.copyRedirectUri'
  return ''
}
