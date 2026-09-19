/**
 * Persona validation — delegates to @axiom/core/contracts for single-source-of-truth.
 *
 * Re-exports the contract parsers so existing imports from this module keep working.
 */

export {
  parseAgentId,
  parsePersonaFiles,
  parsePersonaFieldsPatch,
  parseCreatePersonaPayload,
  parseUpdatePersonaPayload,
  PERSONA_FILE_MAX_BYTES,
  PERSONA_FIELD_LIMITS,
} from '@axiom/core/contracts'
