/**
 * The "Voice messages" section, rendered for real (Vue's SSR renderer, no
 * browser). What this pins down is what breaks in practice: an inherited field
 * must SAY that it is inherited and must not preselect the inherited value, an
 * override must offer a reset, the effective route must be visible, and the
 * backend's validation error must land inline instead of in the console.
 *
 * `$t` returns `key` plus its parameters, so a wrong interpolation is visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import fs from 'node:fs'
import path from 'node:path'
import { SETTINGS_TTS_PROVIDERS, VOICE_NOTE_MAX_CHARS_RANGE } from '@axiom/core/contracts'
import VoiceNotePanel from './components/VoiceNotePanel.vue'
import {
  emptyVoiceNoteDraft,
  voiceNoteDraftFromCatalog,
  type TtsCatalogAccount,
  type VoiceNoteCatalogView,
  type VoiceNoteDraft,
} from './voiceNoteForm'

/**
 * Stand-in for `$t`. The rest parameter is deliberate: `$t` is declared by
 * vue-i18n as a set of overloads whose second parameter can be a plural
 * count, a list or a named-params record, and a mock that names only
 * `Record<string, unknown>` is not assignable to it under
 * `strictFunctionTypes`. `...args: unknown[]` accepts every overload, so this
 * function can be handed to `globalProperties.$t` without a cast.
 */
function translate(key: string, ...args: unknown[]): string {
  const params = args[0]
  return params && typeof params === 'object' ? `${key}(${JSON.stringify(params)})` : key
}

const catalog: VoiceNoteCatalogView & { providers: readonly string[] } = {
  provider: 'openai',
  providerId: 'acct-one',
  model: 'gpt-4o-mini-tts',
  voice: 'nova',
  style: 'calm and clear',
  maxChars: 1300,
  rewrite: true,
  format: 'wav',
  inherited: ['provider', 'providerId', 'model', 'voice', 'style', 'maxChars', 'rewrite'],
  models: ['gpt-4o-mini-tts', 'tts-1'],
  voices: ['nova', 'alloy'],
  providers: SETTINGS_TTS_PROVIDERS,
}

const accounts: TtsCatalogAccount[] = [
  { id: 'acct-one', name: 'Account One', providerType: 'openai', ttsProvider: 'openai' },
  { id: 'acct-two', name: 'Account Two', providerType: 'google', ttsProvider: 'gemini' },
]

async function render(options: {
  draft?: VoiceNoteDraft
  view?: (VoiceNoteCatalogView & { providers: readonly string[] }) | null
  loading?: boolean
  loadError?: string
  saveError?: string
  saved?: boolean
} = {}) {
  vi.stubGlobal('useI18n', () => ({ t: translate }))
  const app = createSSRApp(VoiceNotePanel, {
    catalog: options.view === undefined ? catalog : options.view,
    accounts,
    draft: options.draft ?? emptyVoiceNoteDraft(),
    loading: options.loading ?? false,
    loadError: options.loadError ?? '',
    saveError: options.saveError ?? '',
    saved: options.saved ?? false,
  })
  app.config.globalProperties.$t = translate
  // The real UI components render here (Alert, Button, Input, Label, Switch),
  // so the assertions below see the HTML the browser would get.
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('voice messages settings section', () => {
  it('marks every field as inherited and preselects nothing', async () => {
    const html = await render()
    // One hint per field, carrying the value that is being inherited.
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;openai&quot;})')
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;gpt-4o-mini-tts&quot;})')
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;nova&quot;})')
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;calm and clear&quot;})')
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;1300&quot;})')
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;settings.voiceNote.on&quot;})')
    // Nothing is preselected: every control still carries the empty value and
    // offers the "inherit" option first.
    expect(html).toContain('id="voice-note-provider" value=""')
    expect(html).toContain('id="voice-note-voice" value=""')
    expect(html).toContain('<option value="">settings.voiceNote.inheritOption({&quot;value&quot;:&quot;nova&quot;})</option>')
    // No reset buttons while nothing is overridden.
    expect(html).not.toContain('data-testid="voice-note-reset-voice"')
    expect(html).not.toContain('data-testid="voice-note-reset-rewrite"')
  })

  it('shows the effective route with its inherited fields', async () => {
    const html = await render()
    expect(html).toContain('data-testid="voice-note-effective"')
    expect(html).toContain('settings.voiceNote.effectiveTitle')
    expect(html).toContain('settings.voiceNote.effectiveInherited({&quot;value&quot;:&quot;openai&quot;})')
    expect(html).toContain('settings.voiceNote.effectiveInherited({&quot;value&quot;:&quot;1300&quot;})')
    // The container format is derived, never inherited-or-not.
    expect(html).toContain('wav')
  })

  it('renders overrides as selected values and offers a reset per field', async () => {
    const draft = voiceNoteDraftFromCatalog({
      ...catalog,
      provider: 'gemini',
      providerId: 'acct-two',
      model: 'gemini-2.5-flash-preview-tts',
      voice: 'Charon',
      maxChars: 900,
      rewrite: false,
      inherited: ['style'],
      models: ['gemini-2.5-flash-preview-tts'],
      voices: ['Charon', 'Kore'],
    })
    const html = await render({
      draft,
      view: {
        ...catalog,
        provider: 'gemini',
        providerId: 'acct-two',
        model: 'gemini-2.5-flash-preview-tts',
        voice: 'Charon',
        maxChars: 900,
        rewrite: false,
        format: 'wav',
        inherited: ['style'],
        models: ['gemini-2.5-flash-preview-tts'],
        voices: ['Charon', 'Kore'],
        providers: SETTINGS_TTS_PROVIDERS,
      },
    })
    expect(html).toContain('id="voice-note-provider" value="gemini"')
    expect(html).toContain('id="voice-note-voice" value="Charon"')
    expect(html).toContain('id="voice-note-provider-id" value="acct-two"')
    expect(html).toContain('value="900"')
    // The rewrite switch is off and says so to assistive tech.
    expect(html).toContain('aria-checked="false"')
    for (const field of ['provider', 'providerId', 'model', 'voice', 'maxChars', 'rewrite']) {
      expect(html).toContain(`data-testid="voice-note-reset-${field}"`)
    }
    // `style` stays inherited, so it has no reset and keeps its hint.
    expect(html).not.toContain('data-testid="voice-note-reset-style"')
    expect(html).toContain('settings.voiceNote.inherited({&quot;value&quot;:&quot;calm and clear&quot;})')
  })

  it('renders the backend validation error inline', async () => {
    const message = 'tts.voiceNote.voice "Nope" is not a known gemini voice: Charon, Kore'
    const html = await render({ saveError: message })
    expect(html).toContain('data-testid="voice-note-save-error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('not a known gemini voice')
    expect(html).toContain('text-destructive')
    // The form stays usable next to the error.
    expect(html).toContain('id="voice-note-voice"')
  })

  it('reports an out-of-range character cap before saving', async () => {
    const html = await render({ draft: { ...emptyVoiceNoteDraft(), maxChars: '99999' } })
    expect(html).toContain('data-testid="voice-note-max-chars-error"')
    expect(html).toContain(`settings.voiceNote.maxCharsRange({&quot;min&quot;:${VOICE_NOTE_MAX_CHARS_RANGE.min},&quot;max&quot;:${VOICE_NOTE_MAX_CHARS_RANGE.max}})`)
    expect(html).toContain('aria-invalid="true"')
  })

  it('shows the loading state and a retry after a failed catalog load', async () => {
    expect(await render({ loading: true })).toContain('animate-pulse')
    const failed = await render({ loading: false, loadError: 'catalog unreachable', view: null })
    expect(failed).toContain('catalog unreachable')
    expect(failed).toContain('common.retry')
    expect(failed).not.toContain('id="voice-note-voice"')
  })

  it('confirms a successful save and explains the rewrite switch', async () => {
    const html = await render({ saved: true })
    expect(html).toContain('data-testid="voice-note-saved"')
    expect(html).toContain('settings.voiceNote.saved')
    expect(html).toContain('settings.voiceNote.rewriteHint')
    // Every control is labelled and reachable by keyboard (native controls).
    for (const id of ['voice-note-provider', 'voice-note-provider-id', 'voice-note-model', 'voice-note-voice', 'voice-note-style', 'voice-note-max-chars', 'voice-note-rewrite']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
  })
})

describe('voice messages i18n + wiring', () => {
  const appDir = path.resolve(__dirname, '../..')
  const locales = ['de', 'en'] as const
  const keys = [
    'title', 'subtitle', 'provider', 'providerHint', 'account', 'accountHint', 'accountEmpty',
    'model', 'modelHint', 'voice', 'voiceHint', 'style', 'styleHint',
    'maxChars', 'maxCharsHint', 'maxCharsRange', 'rewrite', 'rewriteHint',
    'inherited', 'inheritOption', 'effectiveInherited', 'effectiveTitle',
    'reset', 'overridden', 'saved', 'none', 'on', 'off', 'format', 'loadFailed',
  ]

  it.each(locales)('has every voice-note string in %s', (code) => {
    const file = JSON.parse(
      fs.readFileSync(path.join(appDir, `i18n/locales/${code}.json`), 'utf-8'),
    ) as { settings: { voiceNote?: Record<string, string> } }
    const section = file.settings.voiceNote
    expect(section, `settings.voiceNote missing in ${code}.json`).toBeDefined()
    for (const key of keys) {
      expect(typeof section![key], `settings.voiceNote.${key} in ${code}.json`).toBe('string')
      expect(section![key]!.length).toBeGreaterThan(1)
    }
    // The rewrite hint has to name the cost of the extra model call.
    expect(section!.rewriteHint!.length).toBeGreaterThan(30)
  })

  it('is mounted in the read-aloud tab and saved with the settings form', async () => {
    const workspace = fs.readFileSync(
      path.join(appDir, 'features/settings/components/SettingsWorkspace.vue'),
      'utf-8',
    )
    expect(workspace).toContain('<VoiceNotePanel')
    expect(workspace).toContain('v-model:draft="voiceNoteDraft"')
    expect(workspace).toContain('buildVoiceNotePayload')
    expect(workspace).toContain('loadTtsCatalog')
    // Same source as the read-aloud form: the backend catalog.
    const api = fs.readFileSync(path.join(appDir, 'api/tts.ts'), 'utf-8')
    expect(api).toContain("'/api/tts/catalog'")
  })
})
