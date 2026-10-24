/**
 * interaction-seal.ts — the secret boundary for interaction rows on their way
 * OUT of the server (S1-A, privacy V3).
 *
 * The implementation lives in `@axiom/core` (S1-C review 1) so the Telegram
 * bot seals its question cards with exactly the same function. Used here by
 * the interactions service (answer, dismiss, draft, list, 409 bodies) and by
 * the websocket bridge (`interaction.open|updated|draft`).
 */
export { sealInteractionValue, sealedInteraction } from '@axiom/core'
