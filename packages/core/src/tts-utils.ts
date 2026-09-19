/**
 * TTS utility functions shared between Web-UI TTS and Telegram Voice.
 *
 * stripMarkdownForTts() cleans agent responses for spoken output:
 * - Removes Markdown formatting (bold, italic, headers, links, images)
 * - Replaces code blocks with "(Code-Block übersprungen)"
 * - Removes emoji
 * - Collapses whitespace
 */

/**
 * Strip Markdown formatting from text for cleaner TTS output.
 * Extended version with emoji removal and code-block replacement.
 */
export function stripMarkdownForTts(text: string): string {
  return (
    text
      // Replace fenced code blocks with spoken indicator
      .replace(/```[\s\S]*?```/g, '(Code-Block übersprungen)')
      // Remove inline code backticks but keep the text
      .replace(/`([^`]+)`/g, '$1')
      // Remove bold/italic markers
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/___([^_]+)___/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove images completely
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
      // Links: keep text, remove URL
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove blockquote markers
      .replace(/^>\s+/gm, '')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Remove list markers (unordered)
      .replace(/^[\s]*[-*+]\s+/gm, '')
      // Remove list markers (ordered)
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // Remove strikethrough
      .replace(/~~([^~]+)~~/g, '$1')
      // Remove emoji (Unicode emoji ranges)
      .replace(
        /(?:[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{E0020}-\u{E007F}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3})+/gu,
        '',
      )
      // Remove HTML tags (in case any leaked through)
      .replace(/<[^>]+>/g, '')
      // Collapse multiple spaces
      .replace(/[ \t]+/g, ' ')
      // Collapse multiple newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * Split text into chunks suitable for TTS generation.
 * Each chunk stays under maxLength characters.
 * Tries to split at sentence boundaries (. ! ? ;) then newlines, then spaces.
 */
export function splitTextForTts(text: string, maxLength: number = 2000): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining.trim())
      break
    }

    // Try to find a sentence boundary within the limit
    let splitAt = -1
    const searchRange = remaining.slice(0, maxLength)

    // Priority 1: sentence end (. ! ?)
    for (let i = searchRange.length - 1; i >= maxLength * 0.3; i--) {
      const ch = searchRange[i]
      if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= searchRange.length || searchRange[i + 1] === ' ' || searchRange[i + 1] === '\n')) {
        splitAt = i + 1
        break
      }
    }

    // Priority 2: semicolon or newline
    if (splitAt < 0) {
      for (let i = searchRange.length - 1; i >= maxLength * 0.3; i--) {
        const ch = searchRange[i]
        if (ch === ';' || ch === '\n') {
          splitAt = i + 1
          break
        }
      }
    }

    // Priority 3: space
    if (splitAt < 0) {
      splitAt = searchRange.lastIndexOf(' ')
      if (splitAt < maxLength * 0.3) splitAt = -1
    }

    // Fallback: hard split
    if (splitAt < 0) {
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks.filter(c => c.length > 0)
}

/**
 * Voice preference settings loaded from settings.json.
 */
export interface VoiceTelegramSettings {
  /** Master switch for Telegram voice output */
  enabled: boolean
  /** Base URL of the TTS service, e.g. http://<tts-host>:7400 (set in settings.json) */
  ttsUrl: string
  /** Which trigger modes are active */
  triggers: {
    command: boolean
    toggle: boolean
    contextAuto: boolean
  }
  /** Request timeout in ms */
  timeoutMs: number
  /** Max text length before auto-splitting into multiple voice notes */
  maxChunkLength: number
}

const DEFAULT_VOICE_SETTINGS: VoiceTelegramSettings = {
  enabled: true,
  ttsUrl: '',
  triggers: {
    command: true,
    toggle: true,
    contextAuto: true,
  },
  timeoutMs: 30000,
  maxChunkLength: 2000,
}

/**
 * Load voice-telegram settings from settings.json.
 */
export function loadVoiceTelegramSettings(loadConfigFn: (name: string) => Record<string, unknown>): VoiceTelegramSettings {
  try {
    const settings = loadConfigFn('settings.json')
    const voice = (settings.voiceTelegram ?? {}) as Partial<VoiceTelegramSettings>
    const triggers = (voice.triggers ?? {}) as Partial<VoiceTelegramSettings['triggers']>
    return {
      enabled: voice.enabled ?? DEFAULT_VOICE_SETTINGS.enabled,
      ttsUrl: voice.ttsUrl ?? DEFAULT_VOICE_SETTINGS.ttsUrl,
      triggers: {
        command: triggers.command ?? DEFAULT_VOICE_SETTINGS.triggers.command,
        toggle: triggers.toggle ?? DEFAULT_VOICE_SETTINGS.triggers.toggle,
        contextAuto: triggers.contextAuto ?? DEFAULT_VOICE_SETTINGS.triggers.contextAuto,
      },
      timeoutMs: voice.timeoutMs ?? DEFAULT_VOICE_SETTINGS.timeoutMs,
      maxChunkLength: voice.maxChunkLength ?? DEFAULT_VOICE_SETTINGS.maxChunkLength,
    }
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS }
  }
}
