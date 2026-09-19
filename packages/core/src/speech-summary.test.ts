import { describe, it, expect, vi } from 'vitest'
import {
  SpeechSummaryEmptyError,
  SpeechSummaryUpstreamError,
  buildSpeechSummaryPrompt,
  summarizeForSpeech,
} from './speech-summary.js'

const LONG_DE = [
  '# Deploy-Bericht',
  '',
  'Der Deploy ist durch, alle Gates sind grün und die App kann die neue Route nutzen.',
  '',
  '| Gate | Baseline | Final |',
  '|---|---|---|',
  '| Tests | 3352 | 3372 |',
  '| Lint | 0 | 0 |',
  '',
  'Weitere Details stehen unter https://offtangent.example.com/report und in `packages/web-backend/src/app.ts`.',
  'Der Commit `3d008ed` liegt auf main. '.repeat(20),
].join('\n')

function completion(text: string) {
  return vi.fn(async (_input: { systemPrompt: string; userPrompt: string }) => ({
    text,
    model: 'test-provider:test-model',
  }))
}

describe('summarizeForSpeech', () => {
  it('speaks a short message as it stands, without a model call', async () => {
    const complete = completion('never called')
    const result = await summarizeForSpeech('Der Deploy ist durch. Alle Gates sind grün.', { complete })
    expect(complete).not.toHaveBeenCalled()
    expect(result.passthrough).toBe(true)
    expect(result.text).toBe('Der Deploy ist durch. Alle Gates sind grün.')
    expect(result.language).toBe('de')
    expect(result.sourceChars).toBe('Der Deploy ist durch. Alle Gates sind grün.'.length)
    expect(result.summaryChars).toBe(result.text.length)
    expect(result.model).toBe('passthrough')
  })

  it('cleans the passed-through short message', async () => {
    const result = await summarizeForSpeech(
      '## ✅ Fertig\n\n- Siehe `packages/core/src/app.ts` und https://example.com/x\n- Alles grün',
      { complete: completion('unused') },
    )
    expect(result.passthrough).toBe(true)
    expect(result.text).not.toMatch(/[#*`|]/)
    expect(result.text).not.toContain('http')
    expect(result.text).toContain('Fertig')
    expect(result.text).toContain('Alles grün')
  })

  it('summarizes a long message and hands the sanitized source to the model', async () => {
    const complete = completion('Der Deploy ist durch. Alle Gates sind grün. Als Nächstes kommt die App.')
    const result = await summarizeForSpeech(LONG_DE, { complete })

    expect(complete).toHaveBeenCalledTimes(1)
    const call = complete.mock.calls[0]![0]
    expect(call.systemPrompt).toContain('German')
    expect(call.userPrompt).toContain('<message>')
    expect(call.userPrompt).not.toContain('|---|')
    expect(call.userPrompt).toContain('Tests, 3352, 3372.')

    expect(result.passthrough).toBe(false)
    expect(result.model).toBe('test-provider:test-model')
    expect(result.language).toBe('de')
    expect(result.sourceChars).toBe(LONG_DE.length)
    expect(result.summaryChars).toBe(result.text.length)
    expect(result.text).toBe('Der Deploy ist durch. Alle Gates sind grün. Als Nächstes kommt die App.')
  })

  it('summarizes a short message that carried a table instead of reading the columns', async () => {
    const complete = completion('Alle Gates sind grün, Tests und Lint ohne Befund.')
    const result = await summarizeForSpeech(
      'Ergebnis:\n\n| Gate | Wert |\n|---|---|\n| Tests | 3372 |\n| Lint | 0 |',
      { complete },
    )
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result.passthrough).toBe(false)
    expect(result.text).toBe('Alle Gates sind grün, Tests und Lint ohne Befund.')
  })

  it('enforces the format on a model that ignores it', async () => {
    const complete = completion([
      '## Ergebnis 🚀',
      '- **Alle Gates grün** (siehe oben), Commit `3d008ed`',
      '- Report unter https://offtangent.example.com/report.md',
      'Satz eins. Satz zwei. Satz drei. Satz vier. Satz fünf. Satz sechs. Satz sieben. Satz acht.',
    ].join('\n'))
    const result = await summarizeForSpeech(LONG_DE, { complete })

    expect(result.text).not.toMatch(/[#*_|`~]/)
    expect(result.text).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(result.text).not.toContain('http')
    expect(result.text).not.toContain('3d008ed')
    expect(result.text).not.toContain('siehe oben')
    expect(result.text).not.toContain('Satz sieben')
    expect(result.text.length).toBeLessThanOrEqual(700)
  })

  it('detects English and asks for an English answer', async () => {
    const complete = completion('The deploy is done and every gate is green.')
    const english = `The deploy is done, all gates are green and the app can use the new route. ${'This is a detailed paragraph about the change. '.repeat(20)}`
    const result = await summarizeForSpeech(english, { complete })
    const call = complete.mock.calls[0]![0]
    expect(call.systemPrompt).toContain('English')
    expect(result.language).toBe('en')
  })

  it('throws empty when nothing speakable is left', async () => {
    const complete = completion('unused')
    await expect(summarizeForSpeech('```\nconst a = 1\n```', { complete }))
      .rejects.toBeInstanceOf(SpeechSummaryEmptyError)
    await expect(summarizeForSpeech('   \n\n', { complete }))
      .rejects.toBeInstanceOf(SpeechSummaryEmptyError)
    expect(complete).not.toHaveBeenCalled()
  })

  it('reports a provider failure as upstream instead of an empty summary', async () => {
    const complete = vi.fn(async (_input: { systemPrompt: string; userPrompt: string }): Promise<{ text: string; model: string }> => {
      throw new Error('connect ETIMEDOUT')
    })
    await expect(summarizeForSpeech(LONG_DE, { complete }))
      .rejects.toBeInstanceOf(SpeechSummaryUpstreamError)
  })

  it('reports an empty model answer as upstream, not as an empty message', async () => {
    const complete = completion('   \n```\n```\n')
    await expect(summarizeForSpeech(LONG_DE, { complete }))
      .rejects.toBeInstanceOf(SpeechSummaryUpstreamError)
  })
})

describe('buildSpeechSummaryPrompt', () => {
  it('names the target language and the format rules', () => {
    expect(buildSpeechSummaryPrompt('de')).toContain('Answer in German')
    expect(buildSpeechSummaryPrompt('en')).toContain('Answer in English')
    expect(buildSpeechSummaryPrompt('de')).toContain('2 to 6 sentences')
    expect(buildSpeechSummaryPrompt('de')).toContain('12000 characters')
  })
})
