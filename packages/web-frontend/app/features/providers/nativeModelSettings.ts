/**
 * Native Ollama per-model settings in the edit-model dialog
 * (plan 2026-10-05-ollama-native-gemma-qwen): the measured num_ctx baseline
 * and the thinking capability. Pure, so the bounds/reset rules are testable
 * without a DOM. Bounds mirror the server (core MIN_NUM_CTX_BASELINE /
 * MAX_NUM_CTX); the server re-validates every value.
 */
import type { ProviderModelUpdatePayloadContract } from '@axiom/core/contracts'

export const NUM_CTX_MIN = 1024
export const NUM_CTX_MAX = 1_048_576

/** '' → null (reset/unknown), valid integer → number, anything else → 'invalid'. Never coerces 4.5, 1e5 or '40k'. */
export function parseNumCtxInput(raw: string | number | null | undefined): number | null | 'invalid' {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  if (!/^\d+$/.test(text)) return 'invalid'
  const n = Number(text)
  return Number.isSafeInteger(n) && n >= NUM_CTX_MIN && n <= NUM_CTX_MAX ? n : 'invalid'
}

/**
 * Only changed native fields are added, so an unchanged dialog never
 * rewrites them. Unchecked reasoning resets to "unset" (null) — never an
 * explicit false that would hide a later catalog value.
 */
export function nativeModelPatch(
  form: { ollamaNumCtx: string | number; reasoning: boolean },
  existing: { ollamaNumCtx?: number; reasoning?: boolean } | undefined,
): Pick<ProviderModelUpdatePayloadContract, 'ollamaNumCtx' | 'reasoning'> | 'invalid' {
  const numCtx = parseNumCtxInput(form.ollamaNumCtx)
  if (numCtx === 'invalid') return 'invalid'
  const patch: Pick<ProviderModelUpdatePayloadContract, 'ollamaNumCtx' | 'reasoning'> = {}
  if (numCtx !== (existing?.ollamaNumCtx ?? null)) patch.ollamaNumCtx = numCtx
  if (form.reasoning !== Boolean(existing?.reasoning)) patch.reasoning = form.reasoning ? true : null
  return patch
}
