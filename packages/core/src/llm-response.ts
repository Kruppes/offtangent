import type { AssistantMessage } from '@earendil-works/pi-ai'

/**
 * pi-ai's `completeSimple()` does NOT throw when the provider rejects a
 * request — it resolves with `stopReason: 'error'`, an empty `content` array
 * and the HTTP error in `errorMessage`. Callers that only look at the text
 * blocks therefore see "the model returned nothing" and silently degrade
 * (a 400 once turned every session summary into "Empty session." and wrote
 * that into the daily memory files for weeks). Route every non-streaming
 * response through here so provider errors surface as exceptions.
 */
export function assertLlmResponseOk(response: AssistantMessage, context: string): AssistantMessage {
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(`${context}: ${response.errorMessage ?? response.stopReason}`)
  }
  return response
}
