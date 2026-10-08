import type { ChatStallInfo } from '~/composables/useChat'

/**
 * Presentation of a persisted / live stall notice (plan
 * 2026-10-09-provider-silence).
 *
 * The watchdog only observes that no output became visible for a while. That
 * is NOT proof of a provider outage: hidden reasoning, a slow first token, a
 * running tool before the fix, or a dead connection all look identical. So a
 * pause is labelled neutrally; only an explicit signal — the watchdog abort or
 * a request error — is rendered as a failure.
 *
 * The label is derived from the structured `stallInfo` instead of the stored
 * row text, so rows written before this change (e.g. "Provider recovered
 * after 45s of silence") are shown with the same truthful wording without any
 * DB migration. Native first-token waits keep their backend text: it carries
 * extra facts (token estimate, budget) the client cannot rebuild.
 */
export type StallNoticeTone = 'pending' | 'neutral' | 'failure'

export interface StallNoticePresentation {
  /** i18n key, or null to render the backend-provided text verbatim. */
  key: string | null
  tone: StallNoticeTone
  icon: 'clock' | 'play' | 'warning' | 'close'
}

export function stallNoticePresentation(stall: ChatStallInfo): StallNoticePresentation {
  const outcome = stall.outcome
  const tone: StallNoticeTone = outcome === 'aborted' || outcome === 'error'
    ? 'failure'
    : outcome === undefined ? 'pending' : 'neutral'
  const icon = tone === 'failure'
    ? 'warning'
    : outcome === 'recovered' ? 'play' : outcome === undefined ? 'clock' : 'close'
  if (stall.phase === 'first_token') return { key: null, tone, icon }
  return { key: `chat.stall.${outcome ?? 'waiting'}`, tone, icon }
}
