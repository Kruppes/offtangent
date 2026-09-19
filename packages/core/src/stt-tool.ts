import fs from 'node:fs'
import nodePath from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
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
