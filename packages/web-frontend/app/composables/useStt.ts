import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import type { ChatAttachment } from '~/composables/useChat'
import {
  INITIAL_DICTATION_STATE,
  dictationReducer,
  levelFromTimeDomain,
  pickTranscriptText,
  pushLevel,
  type DictationEvent,
  type DictationState,
} from '~/utils/dictation'

/** What one finished dictation hands to the composer. */
export interface DictationResult {
  /** Rewritten text when the server sends one, the transcript otherwise. */
  text: string
  /** The recording the server kept (`keepAudio=1`), null when it kept none. */
  audio: ChatAttachment | null
  /** Recording length in ms, for the attachment chip. */
  durationMs: number
}

/** Bars of the live level meter. */
export const LEVEL_BARS = 24
/** Minimum recording duration in ms (Whisper requires >= 0.1s; the server >= 0.25s). */
export const MIN_RECORDING_MS = 300

/**
 * Click-to-dictate for the chat composer (web redesign W1).
 *
 * `start()` opens the microphone, `stop()` ends the recording and uploads it
 * to `POST /api/stt/transcribe?keepAudio=1`, `cancel()` drops it. The phase
 * logic is the pure `dictationReducer`; this composable only owns the browser
 * resources (stream, recorder, analyser, timers) and the kept blob, which
 * stays in memory after a failed upload so `retry()` can send it again.
 */
export function useStt() {
  const { apiFetch } = useApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  /** Whether STT is enabled (cached from server) */
  const sttEnabled = useState<boolean>('stt_enabled', () => false)

  const state = shallowRef<DictationState>(INITIAL_DICTATION_STATE)
  const elapsedMs = ref(0)
  const levels = ref<number[]>([])
  const phase = computed(() => state.value.phase)
  const error = computed(() => state.value.error)
  const canRetry = computed(() => state.value.canRetry)
  const recording = computed(() => state.value.phase === 'recording')
  const transcribing = computed(() => state.value.phase === 'transcribing')
  const busy = computed(() => state.value.phase === 'starting' || state.value.phase === 'recording' || state.value.phase === 'transcribing')

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let audioChunks: Blob[] = []
  let clock: ReturnType<typeof setInterval> | null = null
  let meter: ReturnType<typeof setInterval> | null = null
  /** The last recording that failed to transcribe, kept for `retry()`. */
  let pendingBlob: { blob: Blob; durationMs: number } | null = null
  /** Bumped on cancel/cleanup so a late `onstop` of a dropped recorder is ignored. */
  let generation = 0

  function dispatch(event: DictationEvent) {
    state.value = dictationReducer(state.value, event)
  }

  /** Fetch STT settings from the server to check if enabled */
  async function fetchSttSettings(): Promise<void> {
    try {
      const data = await apiFetch<{ enabled: boolean }>('/api/stt/settings')
      sttEnabled.value = data.enabled
    } catch {
      sttEnabled.value = false
    }
  }

  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** Live level from a Web Audio analyser; optional, dictation works without it. */
  function startMeter(stream: MediaStream) {
    levels.value = []
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined
    if (!Ctor) return
    try {
      audioContext = new Ctor()
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      audioContext.createMediaStreamSource(stream).connect(analyser)
    } catch {
      analyser = null
      return
    }
    const frame = new Uint8Array(analyser.fftSize)
    // Calm bars: ~8 updates a second, and only 2 with reduced motion.
    const every = prefersReducedMotion() ? 500 : 120
    meter = setInterval(() => {
      if (!analyser) return
      analyser.getByteTimeDomainData(frame)
      levels.value = pushLevel(levels.value, levelFromTimeDomain(frame), LEVEL_BARS)
    }, every)
  }

  function stopTimers() {
    if (clock) clearInterval(clock)
    if (meter) clearInterval(meter)
    clock = null
    meter = null
  }

  /** Release microphone, recorder and analyser. */
  function releaseDevices() {
    stopTimers()
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      void audioContext.close().catch(() => {})
      audioContext = null
    }
    analyser = null
  }

  /** Start recording audio from the microphone. */
  async function start(): Promise<void> {
    if (busy.value) return
    pendingBlob = null
    dispatch({ type: 'start' })
    const myGeneration = ++generation
    let stream: MediaStream
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new DOMException('unsupported', 'NotSupportedError')
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = (err as DOMException)?.name
      dispatch({ type: 'start_failed', error: name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError' ? 'permission_denied' : 'mic_error' })
      return
    }
    // Cancelled while the permission prompt was open.
    if (myGeneration !== generation || state.value.phase !== 'starting') {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    mediaStream = stream
    audioChunks = []

    // Prefer audio/webm, fall back to audio/ogg, then default
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : undefined

    try {
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch {
      releaseDevices()
      dispatch({ type: 'start_failed', error: 'mic_error' })
      return
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data)
    }
    mediaRecorder.start()
    const startedAt = Date.now()
    elapsedMs.value = 0
    clock = setInterval(() => { elapsedMs.value = Date.now() - startedAt }, 250)
    startMeter(stream)
    dispatch({ type: 'started', at: startedAt })
  }

  /**
   * Stop the recording and transcribe it. Resolves with the result, or null
   * when there is none (too short, cancelled, failed — the state says which).
   */
  async function stop(): Promise<DictationResult | null> {
    const recorder = mediaRecorder
    const startedAt = state.value.startedAt
    if (state.value.phase !== 'recording' || !recorder || startedAt === null) return null
    const myGeneration = generation
    const durationMs = Date.now() - startedAt
    dispatch({ type: 'stop' })
    stopTimers()

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' }))
      if (recorder.state === 'inactive') resolve(new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' }))
      else recorder.stop()
    })
    mediaRecorder = null
    audioChunks = []
    releaseDevices()
    if (myGeneration !== generation) return null

    if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
      dispatch({ type: 'too_short' })
      return null
    }
    return upload(blob, durationMs)
  }

  /** Send the kept recording of a failed transcription again. */
  async function retry(): Promise<DictationResult | null> {
    const kept = pendingBlob
    if (!kept || !state.value.canRetry) return null
    dispatch({ type: 'retry' })
    return upload(kept.blob, kept.durationMs)
  }

  async function upload(blob: Blob, durationMs: number): Promise<DictationResult | null> {
    const myGeneration = generation
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
    try {
      const formData = new FormData()
      formData.append('file', blob, `recording.${ext}`)
      const token = getAccessToken()
      const apiBase = config.public.apiBase as string
      // keepAudio=1: the server stores the recording as an upload and answers
      // with its descriptor, which the message then carries (as the app does).
      const response = await fetch(`${apiBase}/api/stt/transcribe?keepAudio=1`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      const data = await response.json() as { transcript?: string; rewritten?: string; audio?: ChatAttachment | null }
      if (myGeneration !== generation) return null
      pendingBlob = null
      const text = pickTranscriptText(data)
      const audio = data.audio && typeof data.audio.relativePath === 'string' && data.audio.relativePath ? data.audio : null
      if (!text && !audio) {
        dispatch({ type: 'no_speech' })
        return null
      }
      dispatch(text ? { type: 'transcribed' } : { type: 'no_speech' })
      return { text, audio, durationMs }
    } catch (err) {
      if (myGeneration !== generation) return null
      console.warn('STT transcription failed:', err)
      pendingBlob = { blob, durationMs }
      dispatch({ type: 'failed' })
      return null
    }
  }

  /** Abort a running recording; the audio is dropped and nothing is uploaded. */
  function cancel() {
    if (state.value.phase !== 'recording' && state.value.phase !== 'starting') return
    generation++
    const recorder = mediaRecorder
    mediaRecorder = null
    audioChunks = []
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.ondataavailable = null
      recorder.stop()
    }
    releaseDevices()
    elapsedMs.value = 0
    levels.value = []
    dispatch({ type: 'cancel' })
  }

  /** Close an error; a kept recording is dropped. */
  function dismiss() {
    pendingBlob = null
    dispatch({ type: 'dismiss' })
  }

  /** Full cleanup — stop recording and release resources */
  function cleanup() {
    generation++
    const recorder = mediaRecorder
    mediaRecorder = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    audioChunks = []
    pendingBlob = null
    releaseDevices()
    state.value = INITIAL_DICTATION_STATE
  }

  if (getCurrentScope()) onScopeDispose(cleanup)

  return {
    state,
    phase,
    error,
    canRetry,
    recording,
    transcribing,
    busy,
    elapsedMs,
    levels,
    sttEnabled,
    fetchSttSettings,
    start,
    stop,
    retry,
    cancel,
    dismiss,
    cleanup,
  }
}
