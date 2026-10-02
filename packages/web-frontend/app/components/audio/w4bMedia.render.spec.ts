/**
 * W4b render specs: shared audio player, voice-note bubble, read-aloud panel,
 * context ring, context panel details and the media viewer — every state
 * through Vue's SSR renderer (real SFCs, real props, real template logic).
 * Fixtures are synthetic.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { computed, createSSRApp, defineComponent, h, ref, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import AudioPlayer from './AudioPlayer.vue'
import VoiceNoteBubble from './VoiceNoteBubble.vue'
import MessageSpeechPanel from '../chat/MessageSpeechPanel.vue'
import MessageSpeechActions from '../chat/MessageSpeechActions.vue'
import ContextRing from '../context/ContextRing.vue'
import StrandContextDetails from '../context/StrandContextDetails.vue'
import ChatAttachments from '../ChatAttachments.vue'
import { setPlayerStateForTest } from '~/composables/useAudioPlayer'
import { setSpeechStateForTest } from '~/composables/useMessageSpeech'
import { setStrandContextForTest } from '~/composables/useStrandContext'
import { initialPlayerState } from '~/utils/audioPlayer'
import { mapContextReport } from '~/utils/contextGauge'

const globals = globalThis as Record<string, unknown>
const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)
globals.ref = ref
globals.computed = computed
globals.useRuntimeConfig = () => ({ public: { apiBase: 'https://ot.example' } })
globals.useAuth = () => ({ getAccessToken: () => 'jwt-token', refreshAccessToken: async () => false })
globals.useI18n = () => ({ t, locale: ref('en') })
globals.useApi = () => ({ apiFetch: () => new Promise(() => {}) })
const ttsEnabled = ref(true)
globals.useTts = () => ({ ttsEnabled })

const IconStub = defineComponent({
  props: { name: { type: String, default: '' } },
  setup: props => () => h('i', { 'data-icon': props.name }),
})

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(component, props)
  app.component('AppIcon', IconStub)
  app.config.globalProperties.$t = t as unknown as typeof app.config.globalProperties.$t
  return await renderToString(app)
}

const resolve = () => 'blob:clip'

beforeEach(() => {
  setPlayerStateForTest(initialPlayerState())
  setSpeechStateForTest({})
  ttsEnabled.value = true
})

describe('AudioPlayer', () => {
  it('idle: play button, slider at 0 with the known duration, no audio element in the DOM', async () => {
    const html = await render(AudioPlayer, { clipId: 'c1', label: 'Voice note', resolve, durationHint: 75 })
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="75"')
    expect(html).toContain('aria-valuenow="0"')
    expect(html).toContain('w4b.player.play')
    expect(html).toContain('0:00')
    expect(html).toContain('1:15')
    expect(html).toContain('tabular-nums')
    expect(html).not.toContain('<audio')
    expect(html).not.toMatch(/<[a-z]+[^>]*\sautoplay/)
  })

  it('playing: the owner shows pause and its position; another clip stays idle', async () => {
    setPlayerStateForTest({ id: 'c1', status: 'playing', position: 30, duration: 60, rate: 1.5, error: null })
    const own = await render(AudioPlayer, { clipId: 'c1', label: 'Voice note', resolve, showRate: true })
    expect(own).toContain('w4b.player.pause')
    expect(own).toContain('aria-valuenow="30"')
    expect(own).toContain('0:30')
    expect(own).toContain('1.5×')
    const other = await render(AudioPlayer, { clipId: 'c2', label: 'Other', resolve, durationHint: 10 })
    expect(other).toContain('w4b.player.play')
    expect(other).toContain('aria-valuenow="0"')
  })

  it('error: a readable message', async () => {
    setPlayerStateForTest({ id: 'c1', status: 'error', position: 0, duration: 0, rate: 1, error: 'unsupported' })
    const html = await render(AudioPlayer, { clipId: 'c1', label: 'Voice note', resolve })
    expect(html).toContain('w4b.player.error.unsupported')
    expect(html).toContain('role="alert"')
  })
})

describe('VoiceNoteBubble', () => {
  it('assistant voice note, dictation and audio file carry their kind and label', async () => {
    const note = await render(VoiceNoteBubble, { url: '/api/uploads/2026/01/01/a-voice.wav', seconds: 12, kind: 'assistant' })
    expect(note).toContain('data-voice-note="assistant"')
    expect(note).toContain('w4b.voice.assistant')
    expect(note).toContain('0:12')
    const dictation = await render(VoiceNoteBubble, { url: '/api/uploads/2026/01/01/b-recording.webm', kind: 'dictation' })
    expect(dictation).toContain('data-voice-note="dictation"')
    expect(dictation).toContain('data-icon="mic"')
    const file = await render(VoiceNoteBubble, { url: '/api/uploads/2026/01/01/c-tone.mp3', kind: 'file', name: 'tone.mp3' })
    expect(file).toContain('tone.mp3')
  })
})

describe('read aloud / audio summary', () => {
  it('actions: read aloud, summary and voice note for a stored answer', async () => {
    const html = await render(MessageSpeechActions, { messageId: 7, text: 'Hello', hasVoiceNote: false })
    expect(html).toContain('data-action="read-aloud"')
    expect(html).toContain('data-action="audio-summary"')
    expect(html).toContain('data-action="voice-note"')
  })

  it('actions: no voice-note button when one exists; nothing when speech output is off', async () => {
    const withNote = await render(MessageSpeechActions, { messageId: 7, text: 'Hello', hasVoiceNote: true })
    expect(withNote).not.toContain('data-action="voice-note"')
    ttsEnabled.value = false
    const off = await render(MessageSpeechActions, { messageId: 7, text: 'Hello', hasVoiceNote: false })
    expect(off).not.toContain('data-action')
  })

  it('panel: generating, ready with summary text, error with retry', async () => {
    setSpeechStateForTest({ entries: [['m:7', { mode: 'read', status: 'loading' }]] })
    const loading = await render(MessageSpeechPanel, { messageId: 7, text: 'Hello' })
    expect(loading).toContain('data-speech-state="loading"')
    expect(loading).toContain('w4b.speech.generatingRead')
    expect(loading).toContain('role="status"')

    setSpeechStateForTest({ entries: [['m:7', { mode: 'summary', status: 'ready', src: 'blob:x', summary: 'Short version.' }]] })
    const ready = await render(MessageSpeechPanel, { messageId: 7, text: 'Hello' })
    expect(ready).toContain('data-speech-state="ready"')
    expect(ready).toContain('role="slider"')
    expect(ready).toContain('Short version.')

    setSpeechStateForTest({ entries: [['m:7', { mode: 'read', status: 'error', error: 'unconfigured' }]] })
    const failed = await render(MessageSpeechPanel, { messageId: 7, text: 'Hello' })
    expect(failed).toContain('w4b.speech.error.unconfigured')
    expect(failed).toContain('data-speech-retry')
    expect(failed).toContain('role="alert"')
  })

  it('panel: a failed voice note offers retry; nothing at rest', async () => {
    setSpeechStateForTest({ jobs: [[7, { status: 'error', error: 'upstream' }]] })
    expect(await render(MessageSpeechPanel, { messageId: 7, text: 'Hello' })).toContain('data-voice-note-error')
    setSpeechStateForTest({})
    expect(await render(MessageSpeechPanel, { messageId: 7, text: 'Hello' })).not.toContain('data-speech-panel')
  })
})

describe('ContextRing', () => {
  it.each([
    [0.4, 'ok', false, false],
    [0.75, 'caution', true, false],
    [0.95, 'full', true, true],
  ])('ratio %s → band %s, caution segment %s, full mark %s', async (ratio, band, over, full) => {
    const html = await render(ContextRing, { ratio, label: 'Context', size: 72 })
    expect(html).toContain(`data-band="${band}"`)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Context"')
    expect(html).toContain('data-ring-tick="0.7"')
    expect(html).toContain('data-ring-tick="0.9"')
    expect(html.includes('data-ring-over')).toBe(over)
    expect(html.includes('data-ring-full-mark')).toBe(full)
    expect(html).toContain(`${Math.round(ratio * 100)} %`)
  })

  it('unknown: dashed track, dash instead of a number', async () => {
    const html = await render(ContextRing, { ratio: null, label: 'Unknown', size: 72 })
    expect(html).toContain('data-band="unknown"')
    expect(html).toContain('–')
  })
})

describe('StrandContextDetails', () => {
  const report = (requestTokens: number) => mapContextReport({
    measurement: { state: 'measured', requestTokens, inputTokens: 1000, cacheReadTokens: requestTokens - 1000, cacheWriteTokens: 0, outputTokens: 500, measuredAt: '2026-01-01T10:00:00Z', measuredModelId: 'model-a', stale: false, estimated: false },
    budget: { contextWindow: 200_000 },
    transcript: { state: 'measured', estimatedTokens: 30_000, budgetTokens: 150_000 },
    model: { modelId: 'model-a', displayName: 'Model A' },
  })
  const owned = { status: 'ready' as const, data: { facts: [{ id: 1, text: 'Synthetic fact one' }], summaries: 2, toolCalls: 5, messages: 40, projectName: 'Project X' } }

  it('loading', async () => {
    setStrandContextForTest('s1', { status: 'loading' }, { status: 'loading' })
    const html = await render(StrandContextDetails, { strandId: 's1' })
    expect(html).toContain('data-state="loading"')
    expect(html).toContain('w4b.context.loading')
  })

  it('error with retry, unsupported backend', async () => {
    setStrandContextForTest('s1', { status: 'error', offline: true }, { status: 'unsupported' })
    const html = await render(StrandContextDetails, { strandId: 's1' })
    expect(html).toContain('w4b.context.offline')
    expect(html).toContain('data-context-retry')
    expect(html).toContain('w4b.context.unsupported')
  })

  it.each([[80_000, false], [150_000, true], [190_000, true]])('ready at %s tokens (hint %s)', async (tokens, hint) => {
    setStrandContextForTest('s1', { status: 'ready', data: report(tokens) }, owned)
    const html = await render(StrandContextDetails, { strandId: 's1', projectId: 'p1' })
    expect(html).toContain('data-context-ring')
    expect(html).toContain('200k')
    expect(html).toContain('Model A')
    expect(html.includes('data-context-hint')).toBe(hint)
    expect(html).toContain('Project X')
    expect(html).toContain('Synthetic fact one')
    expect(html).toContain('w4b.context.ringLabel')
  })

  it('empty: unmeasured strand, no facts', async () => {
    setStrandContextForTest('s1', { status: 'ready', data: mapContextReport({ measurement: { state: 'unknown' }, budget: { contextWindow: 200_000 } }) }, { status: 'ready', data: { ...owned.data, facts: [], projectName: null } })
    const html = await render(StrandContextDetails, { strandId: 's1' })
    expect(html).toContain('w4b.context.notMeasured')
    expect(html).toContain('w4b.context.ringUnknown')
    expect(html).toContain('data-context-facts-empty')
    expect(html).toContain('w4b.context.noProject')
  })
})

describe('media viewer', () => {
  const file = (name: string, mimeType: string, kind = 'file') => ({
    kind, originalName: name, storedName: `abc-${name}`, relativePath: `2026/01/01/abc-${name}`, urlPath: `/api/uploads/2026/01/01/abc-${name}`, mimeType, size: 4096,
  })

  it('image opens a lightbox, audio uses the shared player, video is native without autoplay, pdf is a card', async () => {
    const html = await render(ChatAttachments, {
      attachments: [file('shot.png', 'image/png', 'image'), file('tone.wav', 'audio/wav'), file('clip.mp4', 'video/mp4'), file('doc.pdf', 'application/pdf'), file('app.apk', 'application/octet-stream')],
      role: 'assistant',
    })
    expect(html).toContain('data-lightbox-open')
    expect(html).toContain('data-attachment-media="audio"')
    expect(html).toContain('data-voice-note="file"')
    expect(html).toMatch(/<video[^>]*controls/)
    expect(html).toMatch(/<video[^>]*preload="metadata"/)
    expect(html).not.toMatch(/<[a-z]+[^>]*\sautoplay/)
    expect(html).toContain('data-attachment-pdf')
    expect(html).toContain('data-pdf-toggle')
    // The preview is loaded on request only, never as an iframe.
    expect(html).not.toContain('data-pdf-preview')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('https://ot.example/api/uploads/2026/01/01/abc-doc.pdf?download=1&amp;token=jwt-token')
    expect(html).toContain('data-attachment-media="file"')
  })

  it('an audio file on a user message is the kept dictation', async () => {
    const html = await render(ChatAttachments, { attachments: [file('recording.webm', 'audio/webm')], role: 'user' })
    expect(html).toContain('data-voice-note="dictation"')
  })
})
