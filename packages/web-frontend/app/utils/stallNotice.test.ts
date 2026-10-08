/** Stall notice wording/tone (plan 2026-10-09-provider-silence). Synthetic values only. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { stallNoticePresentation } from './stallNotice'
import type { ChatStallInfo, ChatStallOutcome } from '~/composables/useChat'

const base: ChatStallInfo = { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 45_000 }
const locales = ['de', 'en'].map(l => ({
  l,
  json: JSON.parse(readFileSync(new URL(`../i18n/locales/${l}.json`, import.meta.url), 'utf8')) as Record<string, Record<string, Record<string, string>>>,
}))

describe('stallNoticePresentation', () => {
  it('renders a pause and its end neutrally, never as a failure', () => {
    expect(stallNoticePresentation(base)).toEqual({ key: 'chat.stall.waiting', tone: 'pending', icon: 'clock' })
    expect(stallNoticePresentation({ ...base, outcome: 'recovered' })).toEqual({ key: 'chat.stall.recovered', tone: 'neutral', icon: 'play' })
    expect(stallNoticePresentation({ ...base, outcome: 'ended' }).tone).toBe('neutral')
    expect(stallNoticePresentation({ ...base, outcome: 'canceled' }).tone).toBe('neutral')
  })

  it('reserves the failure tone for explicit abort / error signals', () => {
    for (const outcome of ['aborted', 'error'] as const) {
      expect(stallNoticePresentation({ ...base, outcome })).toEqual({ key: `chat.stall.${outcome}`, tone: 'failure', icon: 'warning' })
    }
  })

  it('keeps the backend text for native first-token waits (budget / token facts)', () => {
    expect(stallNoticePresentation({ ...base, phase: 'first_token' }).key).toBeNull()
    expect(stallNoticePresentation({ ...base, phase: 'first_token', outcome: 'aborted' })).toEqual({ key: null, tone: 'failure', icon: 'warning' })
  })

  it('has a neutral translation for every outcome in every locale', () => {
    const outcomes: Array<ChatStallOutcome | 'waiting'> = ['waiting', 'recovered', 'ended', 'canceled', 'aborted', 'error']
    for (const { l, json } of locales) {
      for (const outcome of outcomes) {
        const text = json.chat!.stall![outcome]
        expect(text, `${l}.chat.stall.${outcome}`).toBeTruthy()
        if (outcome !== 'aborted' && outcome !== 'error') {
          expect(text, `${l}.chat.stall.${outcome}`).not.toMatch(/recovered|erholt|ausfall|outage|failed|fehlgeschlagen|Aussetzer|stopped responding/i)
        }
      }
      expect(json.usage!.stalls!.title).not.toMatch(/Aussetzer|stall/i)
    }
  })
})
