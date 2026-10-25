/**
 * H3 of the clock companion (KONZEPT-COMPANION §2.3): a spoken short version
 * of an answer whose first paragraph ignored the "core answer first" hint (H2)
 * and does not fit the clock's spoken limit.
 *
 * Only a fallback: the tracker calls it when no whole sentence of the first
 * paragraph fits, with a timeout, and falls back to a word cut when it fails.
 * It uses the router chain (the small, fast models the routing already pays
 * for), never the persona's model.
 */
import { completeSimple } from './pi-models.js'
import { buildRouterModel, resolveRouterChain } from './router-model.js'
import { redactKnown } from './secret-boundary.js'
import type { ResolvedRouterModel } from './router-model.js'

export const VOICE_SHORTEN_SYSTEM_PROMPT = 'Du kuerzt eine Antwort fuer eine Sprachausgabe. '
  + 'Antworte mit ein bis zwei kurzen, gesprochenen Saetzen, die die Kernaussage wiedergeben, '
  + 'in der Sprache des Textes. Kein Markdown, keine Listen, keine Links, keine Einleitung, keine Anfuehrungszeichen.'

/** Upper bound of the text handed to the model; the core answer is at the start. */
const INPUT_MAX = 4_000

export type VoiceShortenCompletion = (systemPrompt: string, userPrompt: string) => Promise<string>

export interface VoiceShortenOptions {
  chain?: ResolvedRouterModel[]
  /** Model call override (tests). */
  complete?: VoiceShortenCompletion
}

async function defaultCompletion(chain: ResolvedRouterModel[], systemPrompt: string, userPrompt: string): Promise<string> {
  for (const entry of chain) {
    const handle = await buildRouterModel(entry)
    if (!handle) continue
    const response = await completeSimple(handle.model, {
      systemPrompt,
      messages: [{ role: 'user' as const, content: userPrompt, timestamp: Date.now() }],
    }, { apiKey: handle.apiKey })
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage ?? response.stopReason)
    }
    return response.content
      .filter(item => item.type === 'text')
      .map(item => (item as { type: 'text'; text: string }).text)
      .join('')
      .trim()
  }
  throw new Error('no shorten model available')
}

/**
 * A short spoken version of `text` in at most `maxChars` characters, or null
 * when no model is available, the call fails or the answer is empty or too
 * long. The caller owns the timeout and the deterministic fallback.
 */
export async function shortenForVoice(text: string, maxChars: number, options: VoiceShortenOptions = {}): Promise<string | null> {
  // The answer comes from a turn whose context is sealed, so it carries
  // handles, not values. redactKnown is the last net in case a known value
  // still made it into the streamed text (secret-model-paths.test.ts).
  const input = redactKnown(text.trim().slice(0, INPUT_MAX))
  if (!input) return null
  const chain = options.complete ? [] : options.chain ?? resolveRouterChain()
  if (!options.complete && chain.length === 0) return null
  const complete = options.complete ?? ((s: string, u: string) => defaultCompletion(chain, s, u))
  let out: string
  try {
    out = await complete(VOICE_SHORTEN_SYSTEM_PROMPT, `Hoechstens ${maxChars} Zeichen.\n\n${input}`)
  } catch {
    return null
  }
  const flat = out.replace(/\s+/g, ' ').replace(/^["„»]+|["“«]+$/g, '').trim()
  if (!flat || flat.length > maxChars) return null
  return flat
}
