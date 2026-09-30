export function useStt() {
  const { apiFetch } = useApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  /** Whether recording is in progress */
  const recording = useState<boolean>('stt_recording', () => false)
  /** Whether transcription is in progress */
  const transcribing = useState<boolean>('stt_transcribing', () => false)
  /** Current error message */
  const error = useState<string | null>('stt_error', () => null)
  /** Whether STT is enabled (cached from server) */
  const sttEnabled = useState<boolean>('stt_enabled', () => false)

  /** Minimum recording duration in ms (Whisper requires >= 0.1s) */
  const MIN_RECORDING_MS = 300

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let audioChunks: Blob[] = []
  let recordingStartedAt = 0

  /** Fetch STT settings from the server to check if enabled */
  async function fetchSttSettings(): Promise<void> {
    try {
      const data = await apiFetch<{ enabled: boolean }>('/api/stt/settings')
      sttEnabled.value = data.enabled
    } catch {
      sttEnabled.value = false
    }
  }

  /** Start recording audio from the microphone */
  async function startRecording(): Promise<void> {
    error.value = null

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = (err as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        error.value = 'permission_denied'
      } else {
        error.value = 'mic_error'
      }
      return
    }

    audioChunks = []

    // Prefer audio/webm, fall back to audio/ogg, then default
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : undefined

    try {
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
    } catch {
      error.value = 'mic_error'
      cleanupStream()
      return
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data)
      }
    }

    mediaRecorder.start()
    recordingStartedAt = Date.now()
    recording.value = true
  }

  /** Stop recording and transcribe the audio. Returns the transcript text or null on error. */
  async function stopAndTranscribe(): Promise<string | null> {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      recording.value = false
      return null
    }

    return new Promise<string | null>((resolve) => {
      mediaRecorder!.onstop = async () => {
        recording.value = false
        cleanupStream()

        if (audioChunks.length === 0) {
          resolve(null)
          return
        }

        // Skip transcription for very short recordings (< 0.3s)
        const durationMs = Date.now() - recordingStartedAt
        if (durationMs < MIN_RECORDING_MS) {
          audioChunks = []
          error.value = 'recording_too_short'
          resolve(null)
          return
        }

        const mimeType = mediaRecorder?.mimeType ?? 'audio/webm'
        const blob = new Blob(audioChunks, { type: mimeType })
        audioChunks = []

        // Determine file extension from mime type
        const ext = mimeType.includes('ogg') ? 'ogg' : 'webm'

        transcribing.value = true
        error.value = null

        try {
          const formData = new FormData()
          formData.append('file', blob, `recording.${ext}`)

          const token = getAccessToken()
          const apiBase = config.public.apiBase as string

          const response = await fetch(`${apiBase}/api/stt/transcribe`, {
            method: 'POST',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: formData,
          })

          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string }
            throw new Error(body.error ?? `HTTP ${response.status}`)
          }

          const data = await response.json() as { transcript: string; rewritten?: string }
          const text = data.rewritten ?? data.transcript
          resolve(text || null)
        } catch (err) {
          console.error('STT transcription failed:', err)
          error.value = 'transcribe_error'
          resolve(null)
        } finally {
          transcribing.value = false
        }
      }

      mediaRecorder!.stop()
    })
  }

  /** Stop media tracks to release the microphone */
  function cleanupStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
  }

  /** Full cleanup — stop recording and release resources */
  function cleanup() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    }
    mediaRecorder = null
    recording.value = false
    transcribing.value = false
    cleanupStream()
  }

  return {
    recording,
    transcribing,
    error,
    sttEnabled,
    fetchSttSettings,
    startRecording,
    stopAndTranscribe,
    cleanup,
  }
}
