import fs from 'node:fs'
import nodePath from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { getWorkspaceDir } from './workspace.js'
import { loadSttSettings, transcribeAudio } from './stt.js'

// ── MIME type mapping ─────────────────────────────────────────────────

const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
}

const SUPPORTED_EXTENSIONS = Object.keys(AUDIO_EXTENSIONS)

// ── Size limits ───────────────────────────────────────────────────────

/**
 * OpenAI-compatible transcription endpoints reject uploads above 25 MB
 * (documented API limit, potentially decimal: 25,000,000 bytes). Choose
 * 23 MiB = 24,117,248 bytes, below that limit even with decimal counting.
 * This fork does not re-encode, so oversized files are refused before reading.
 */
export const OPENAI_STT_MAX_BYTES = 23 * 1024 * 1024

/**
 * Upper bound for every other backend (whisper-url, Ollama, Deepgram). They
 * have no fixed small limit, but the tool reads the whole file into memory
 * (Ollama additionally base64-encodes it), so an unbounded size can push the
 * process into memory pressure. 100 MiB covers well over an hour of
 * compressed speech.
 */
export const MAX_TRANSCRIBE_BYTES = 100 * 1024 * 1024

function transcribeLimitBytes(provider: string): number {
  return provider === 'openai' ? OPENAI_STT_MAX_BYTES : MAX_TRANSCRIBE_BYTES
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Resolve a path relative to the workspace directory.
 */
function resolveWorkspacePath(filePath: string): string {
  if (nodePath.isAbsolute(filePath)) return filePath
  return nodePath.resolve(getWorkspaceDir(), filePath)
}

/**
 * Create the `transcribe_audio` agent tool.
 *
 * Transcribes audio files from the workspace using the configured STT provider.
 * Supports common formats: mp3, wav, ogg, webm, m4a, flac.
 *
 * Primary use case: user asks the agent to transcribe a downloaded audio file
 * (e.g. from yt-dlp). The agent downloads the audio via shell, then uses this
 * tool to transcribe it.
 */
export function createTranscribeAudioTool(): AgentTool {
  return {
    name: 'transcribe_audio',
    label: 'Transcribe Audio',
    description:
      'Transcribe an audio file to text using the configured speech-to-text provider. ' +
      'Supports common audio formats (mp3, wav, ogg, webm, m4a, flac). ' +
      'The file must exist in the workspace.',
    parameters: Type.Object({
      path: Type.String({
        description: 'Path to the audio file, relative to workspace root.',
      }),
      language: Type.Optional(
        Type.String({
          description: 'Language code (e.g., "en", "de") for improved accuracy. Default: auto-detect.',
        }),
      ),
      rewrite: Type.Optional(
        Type.Boolean({
          description: 'Clean up the transcript by removing filler words and repetitions. Default: false.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, language, rewrite = false } = params as {
        path: string
        language?: string
        rewrite?: boolean
      }

      try {
        // Check STT is enabled
        const settings = loadSttSettings()
        if (!settings.enabled) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Speech-to-text is not enabled. Enable it in Settings → Speech-to-Text.' }],
            details: { error: true },
          }
        }

        // Resolve path
        const resolved = resolveWorkspacePath(filePath)

        // Check file exists
        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${resolved}` }],
            details: { error: true },
          }
        }

        // Check file is readable
        try {
          fs.accessSync(resolved, fs.constants.R_OK)
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Error: File is not readable: ${resolved}` }],
            details: { error: true },
          }
        }

        // Validate extension
        const ext = nodePath.extname(resolved).toLowerCase()
        if (!AUDIO_EXTENSIONS[ext]) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Unsupported audio format "${ext}". Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`,
            }],
            details: { error: true },
          }
        }

        const mimeType = AUDIO_EXTENSIONS[ext]
        const filename = nodePath.basename(resolved)

        // Check the size before reading: the whole file goes into memory.
        const limit = transcribeLimitBytes(settings.provider)
        const size = fs.statSync(resolved).size
        if (size > limit) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Audio file is too large to transcribe (${formatMiB(size)}, limit ${formatMiB(limit)} for STT provider "${settings.provider}"). Split or compress the recording first.`,
            }],
            details: { error: true },
          }
        }

        // Read file
        const buffer = fs.readFileSync(resolved)

        // Transcribe
        const result = await transcribeAudio(buffer, { language, filename })

        // If rewrite requested and rewrite is enabled in settings, apply rewrite
        if (rewrite && settings.rewrite.enabled && settings.rewrite.providerId) {
          // Rewrite is handled by the caller (the agent itself can clean up the text)
          // For now, return the raw transcript with a note about rewriting
          return {
            content: [{
              type: 'text' as const,
              text: result.rewritten ?? result.transcript,
            }],
            details: {
              path: resolved,
              filename,
              mimeType,
              language: language ?? 'auto',
              rewrite: true,
              rewriteNote: result.rewritten
                ? undefined
                : 'Rewrite was requested. Please clean up the transcript by removing filler words, false starts, and repetitions while preserving the meaning.',
            },
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: result.transcript,
          }],
          details: {
            path: resolved,
            filename,
            mimeType,
            language: language ?? 'auto',
            rewrite: false,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error transcribing audio: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}
