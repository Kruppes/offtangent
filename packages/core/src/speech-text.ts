/**
 * speech-text.ts: turning written assistant messages into something a text to
 * speech voice can read out.
 *
 * Two steps, both pure and both testable without a model:
 *
 *  - {@link sanitizeSpeechSource} prepares the SOURCE for the summarizer.
 *    Code blocks, tool dumps and log walls are dropped (a model that reads
 *    them starts quoting them), tables are flattened into plain rows, and the
 *    rest keeps its wording so the summary stays faithful.
 *  - {@link cleanSpokenText} is the hard gate on the OUTPUT. Everything a
 *    voice must not pronounce is removed here — markdown, urls, paths, commit
 *    hashes, emoji, bullets, bracketed asides. The prompt asks the model for
 *    the same thing, but the rule is enforced in code because a model that
 *    forgets it once would ship a spoken asterisk to the user.
 *
 * The same cleaner runs on the passthrough path (a message short enough to be
 * read as it stands), so a short answer and a summary are cleaned by exactly
 * one implementation.
 */

/** Hard cap for the source handed to the model, counted from the start. */
export const SPEECH_SOURCE_CAP = 12_000

/**
 * A cleaned message below this many characters is read out as it stands
 * instead of being summarized: a model call would cost a second and could
 * only lose information.
 */
export const SPEECH_DIRECT_MAX_CHARS = 600

/** Upper bound for a spoken summary: ~45 s at ~15 characters per second. */
export const SPEECH_MAX_CHARS = 700

/** Upper bound in sentences (SPEC: 2 to 6 sentences). */
export const SPEECH_MAX_SENTENCES = 6

const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'kt', 'kts', 'java', 'py', 'rb', 'go', 'rs',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'env', 'sql', 'db', 'log', 'txt', 'csv', 'xml',
  'html', 'css', 'scss', 'apk', 'aab', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'zip', 'tar', 'gz',
]

const URL_TLDS = [
  'com', 'de', 'org', 'net', 'io', 'dev', 'xyz', 'app', 'sh', 'ai', 'co', 'eu', 'info', 'me', 'gg',
]

/** Lines that are machine output, not prose: timestamps, log levels, shell prompts. */
const LOG_LINE = new RegExp(
  [
    '^\\s*\\[?\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}',
    '^\\s*\\d{2}:\\d{2}:\\d{2}[.,]?\\d*\\s',
    '^\\s*\\[?(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\\]?[:\\s]',
    '^\\s*(at\\s+\\w[\\w.$]*\\s*\\(|\\+\\+\\+|---\\s|@@\\s)',
    '^\\s*\\$\\s+\\S',
    '^\\s*[A-Z]\\/[\\w.]+\\s*\\(\\s*\\d+\\s*\\):', // android logcat
  ].join('|'),
  'i',
)

/** A markdown table separator row (`|---|:--:|`). */
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.slice(1).includes('|')
}

/**
 * Ratio of letters in a line. A line made of hashes, numbers and punctuation
 * (hash dumps, number columns, ascii art, base64) is noise for a voice.
 */
function letterRatio(line: string): number {
  const letters = line.match(/\p{L}/gu)?.length ?? 0
  return line.length === 0 ? 1 : letters / line.length
}

/** One table row as a spoken clause: `| a | b |` -> `a, b.` */
function flattenTableRow(line: string): string {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).filter(Boolean)
  if (cells.length === 0) return ''
  const joined = cells.join(', ')
  return /[.!?]$/.test(joined) ? joined : `${joined}.`
}

export interface SanitizedSpeechSource {
  text: string
  /**
   * The message contained a markdown table. Its rows survive as flattened
   * clauses, but they are columns of numbers in prose clothing — a message
   * like that always goes through the summarizer, however short it is.
   */
  hadTable: boolean
}

/**
 * Prepare the raw message for the summarizer: drop everything the model
 * should not read (code, tool output, logs), flatten tables, keep prose.
 * The result is capped at {@link SPEECH_SOURCE_CAP} characters from the start.
 */
export function sanitizeSpeechSourceDetailed(raw: string): SanitizedSpeechSource {
  if (typeof raw !== 'string' || raw.length === 0) return { text: '', hadTable: false }
  let hadTable = false

  let text = raw.replace(/\r\n?/g, '\n')

  // Fenced code blocks, including the ```offtangent interaction fences and an
  // unterminated fence at the end of a truncated message.
  text = text.replace(/```[\s\S]*?```/g, '\n')
  text = text.replace(/```[\s\S]*$/, '\n')
  text = text.replace(/~~~[\s\S]*?~~~/g, '\n')

  // Tool transcripts and thinking blocks that leaked into the content.
  text = text.replace(/<(tool_[\w-]+|thinking|antml:[\w-]+|function_results?|system-reminder)\b[\s\S]*?<\/\1>/gi, '\n')
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (LOG_LINE.test(line)) continue
    if (isTableRow(line)) {
      hadTable = true
      if (TABLE_SEPARATOR.test(line)) continue
      const row = flattenTableRow(line)
      if (row) kept.push(row)
      continue
    }
    // Indented block (4+ spaces) that is not prose: leftover code or output.
    if (/^ {4,}\S/.test(line) && letterRatio(line) < 0.6) continue
    if (line.trim().length > 20 && letterRatio(line) < 0.35) continue
    kept.push(line)
  }

  text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > SPEECH_SOURCE_CAP) {
    // Cut on a line boundary so the model never sees half a sentence.
    const cut = text.slice(0, SPEECH_SOURCE_CAP)
    const lastBreak = cut.lastIndexOf('\n')
    text = (lastBreak > SPEECH_SOURCE_CAP * 0.6 ? cut.slice(0, lastBreak) : cut).trim()
  }
  return { text, hadTable }
}

/** {@link sanitizeSpeechSourceDetailed}, text only. */
export function sanitizeSpeechSource(raw: string): string {
  return sanitizeSpeechSourceDetailed(raw).text
}

/** Bracketed asides that only make sense on screen. */
const REFERENCE_ASIDE = /\b(siehe|s\.\s?o|s\.\s?u|vgl|see|cf|above|below|oben|unten|abb|fig|zeile|line|screenshot|link)\b/i

function unwrapBrackets(text: string): string {
  let out = text
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(/\(([^()]{0,120})\)/g, (_match, inner: string) => {
      const content = inner.trim()
      if (!content || REFERENCE_ASIDE.test(content) || content.length <= 3) return ' '
      return `, ${content}`
    })
    if (next === out) break
    out = next
  }
  // Square brackets never survive: they are markdown leftovers or references.
  out = out.replace(/\[([^\][]{0,120})\]/g, (_match, inner: string) => {
    const content = inner.trim()
    if (!content || REFERENCE_ASIDE.test(content) || /^[x\s✓]*$/i.test(content)) return ' '
    return ` ${content} `
  })
  return out.replace(/[()[\]{}]/g, ' ')
}

/**
 * The hard output gate. Removes everything a TTS voice must not pronounce and
 * normalizes the result into one line of plain prose.
 */
export function cleanSpokenText(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''

  let text = raw.replace(/\r\n?/g, '\n')

  // Code first, so its contents never reach the url/path rules below.
  text = text.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/, ' ')
  text = text.replace(/`([^`]*)`/g, ' $1 ').replace(/`/g, ' ')

  // Markdown links and images keep their label, never their target.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ')

  // Urls, mail addresses, bare hosts.
  text = text.replace(/\bhttps?:\/\/\S+/gi, ' ')
  text = text.replace(/\b(?:www|ftp)\.\S+/gi, ' ')
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, ' ')
  text = text.replace(
    new RegExp(`\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${URL_TLDS.join('|')})\\b(?:\\/\\S*)?`, 'gi'),
    ' ',
  )

  // Paths: absolute, home relative, or anything with two or more segments.
  text = text.replace(/(?:^|\s)[~.]{0,2}\/[^\s,;]*/g, ' ')
  text = text.replace(/\b[\w.-]+\/[\w.-]+(?:\/[\w.-]+)+\b/g, ' ')
  text = text.replace(new RegExp(`\\b[\\w.-]+\\.(?:${FILE_EXTENSIONS.join('|')})\\b`, 'gi'), ' ')

  // Commit hashes and other hex blobs (a hash always carries a digit).
  text = text.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, ' ')

  // Emoji, pictographs and screen-only symbols.
  text = text.replace(/\p{Extended_Pictographic}/gu, ' ')
  text = text.replace(/\uFE0E|\uFE0F|\u200D|\u2060/g, '')
  text = text.replace(/[→←↔⇒⇐➜➡▶►▸•·▪▫◦‣⁃★☆✓✔✗✘※▲▼]/g, ' ')

  // Markdown structure.
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+[.)]\s+/gm, '')
  text = text.replace(/^\s*[-*_=]{3,}\s*$/gm, ' ')
  text = text.replace(/\|/g, ', ')
  text = text.replace(/\*+/g, ' ')
  text = text.replace(/~~/g, ' ')
  text = text.replace(/(^|\s)_+|_+($|\s)/g, '$1$2')
  text = text.replace(/_/g, ' ')

  text = unwrapBrackets(text)

  // Operators a voice should not spell out.
  text = text.replace(/\s=+\s/g, ', ')

  // One line of prose.
  text = text.replace(/\s+/g, ' ')
  text = text.replace(/\s+([,.;:!?])/g, '$1')
  text = text.replace(/,\s*(?=[,.;:])/g, '')
  text = text.replace(/([.!?])\1{1,}/g, '$1')
  text = text.replace(/\s*[:;]\s*/g, ', ')
  text = text.replace(/,\s*,/g, ',')
  text = text.replace(/…/g, '.')
  text = text.replace(/^[\s,.;:!?-]+/, '')
  text = text.replace(/\s+/g, ' ').trim()
  // A trailing comma or dash is an artefact of something that was removed.
  text = text.replace(/[\s,;:-]+$/, '')
  return text.trim()
}

/**
 * Function words plus the handful of content words a one-line status message
 * consists of ("Fertig.", "Erledigt, Deploy läuft."). Without those, short
 * answers carry no evidence at all and would all fall to the default.
 */
const GERMAN_MARKERS = [
  'und', 'der', 'die', 'das', 'ist', 'nicht', 'mit', 'für', 'auf', 'ein', 'eine', 'sind', 'wurde',
  'wurden', 'noch', 'auch', 'dass', 'aber', 'oder', 'kann', 'muss', 'wird', 'sich', 'von', 'dem',
  'den', 'beim', 'nach', 'über', 'nur', 'schon', 'jetzt', 'alle', 'keine', 'grün', 'läuft',
  'ich', 'wir', 'sie', 'mir', 'dir', 'uns', 'habe', 'haben', 'hat', 'hatte', 'war', 'waren',
  'wie', 'wenn', 'weil', 'damit', 'durch', 'gegen', 'zwischen', 'ohne', 'sehr', 'mehr', 'hier',
  'dann', 'danach', 'deshalb', 'zum', 'zur', 'vom', 'als', 'bis', 'soll', 'sollte', 'bitte',
  'fertig', 'erledigt', 'gemacht', 'geht', 'gibt', 'liegt', 'steht', 'kommt', 'braucht', 'fehlt',
]

const ENGLISH_MARKERS = [
  'the', 'and', 'is', 'are', 'was', 'were', 'not', 'with', 'for', 'this', 'that', 'have', 'has',
  'from', 'you', 'your', 'all', 'but', 'can', 'will', 'should', 'there', 'been', 'they', 'into',
  'after', 'before', 'now', 'green', 'running',
  'of', 'to', 'it', 'its', 'we', 'he', 'she', 'them', 'their', 'what', 'when', 'where', 'which',
  'while', 'about', 'over', 'under', 'because', 'just', 'than', 'then', 'here', 'still', 'yet',
  'does', 'did', 'done', 'finished', 'failed', 'fixed', 'ready', 'healthy', 'needs', 'need',
  'works', 'working', 'only', 'again', 'both', 'each', 'these', 'those',
]

export type SpeechLanguage = 'de' | 'en'

/**
 * Language of the source message, the field the app needs to pick a voice.
 *
 * Stopword counting in both directions, with umlauts as a TIEBREAKER only.
 * The bonus used to be large enough to outvote the stopwords, which made an
 * English message full of German names ("Müller and Schröder from Köln…")
 * come out German and be read by the wrong voice. Umlauts now add at most
 * one point, so clear stopword evidence always wins and a short German line
 * without stopwords ("Grüße") still tips to German.
 *
 * Known and accepted limits, the field is a two-way switch by contract:
 *  - Only `de` and `en` exist. A French or Spanish message scores no markers
 *    and falls back to German, the language this instance is operated in.
 *  - A genuinely mixed message follows the half that carries more stopwords;
 *    there is no third answer to give.
 *  - A tie (no evidence at all, e.g. a bare number) is German by the same
 *    fallback rule.
 */
export function detectSpeechLanguage(text: string): SpeechLanguage {
  const words = (text.toLowerCase().match(/[\p{L}]+/gu) ?? [])
  if (words.length === 0) return 'de'
  const german = new Set(GERMAN_MARKERS)
  const english = new Set(ENGLISH_MARKERS)
  let de = 0
  let en = 0
  for (const word of words) {
    if (german.has(word)) de += 1
    if (english.has(word)) en += 1
  }
  const umlauts = text.match(/[äöüßÄÖÜ]/g)?.length ?? 0
  de += Math.min(umlauts, 4) * 0.25
  return de >= en ? 'de' : 'en'
}

/** Short trailing token (`z.`, `B.`, `ca.`, `Nr.`) — the mark of an abbreviation. */
const SHORT_TRAILING_TOKEN = /(?:^|\s)\p{L}{1,4}\.$/u

/**
 * Two split pieces that belong to one sentence: the first ends in an
 * abbreviation and the second either continues in lower case or is another
 * abbreviation. `Das ist gut. Danach kommt X.` stays two sentences.
 */
function shouldGlue(previous: string, next: string): boolean {
  if (previous.length <= 4) return true
  if (!SHORT_TRAILING_TOKEN.test(previous)) return false
  return next.length <= 4 || /^\p{Ll}/u.test(next)
}

/**
 * Split into sentences. A period only ends a sentence when whitespace or the
 * end of the text follows it — otherwise `0.9.9.1` and `3.5` would each break
 * into three "sentences" and the cap below would cut a version number in half.
 * Fragments of an abbreviation (`z. B.`) are glued to the next sentence.
 */
function splitSentences(text: string): string[] {
  const pieces: string[] = []
  const boundary = /[.!?…]+(?=\s|$)/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length
    const piece = text.slice(start, end).trim()
    if (piece) pieces.push(piece)
    start = end
  }
  const rest = text.slice(start).trim()
  if (rest) pieces.push(rest)
  if (pieces.length === 0) return [text.trim()]

  const merged: string[] = []
  for (const piece of pieces) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && shouldGlue(previous, piece)) {
      merged[merged.length - 1] = `${previous} ${piece}`
      continue
    }
    merged.push(piece)
  }
  return merged
}

/**
 * Keep the spoken text inside the contract: at most
 * {@link SPEECH_MAX_SENTENCES} sentences and {@link SPEECH_MAX_CHARS}
 * characters, always ending on a sentence boundary. A model that answers with
 * one long sentence is not padded — two sentences cannot be invented, only
 * asked for in the prompt.
 */
export function limitSpokenSentences(
  text: string,
  maxSentences = SPEECH_MAX_SENTENCES,
  maxChars = SPEECH_MAX_CHARS,
): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const sentences = splitSentences(trimmed)

  const kept: string[] = []
  for (const sentence of sentences.slice(0, maxSentences)) {
    const candidate = kept.length === 0 ? sentence : `${kept.join(' ')} ${sentence}`
    if (candidate.length > maxChars && kept.length > 0) break
    kept.push(sentence)
    if (kept.join(' ').length >= maxChars) break
  }

  let out = kept.join(' ').trim()
  if (out.length > maxChars) {
    // A single sentence longer than the budget: cut on a word boundary and
    // close it, a voice must not stop mid word.
    const cut = out.slice(0, maxChars)
    const lastSpace = cut.lastIndexOf(' ')
    out = `${(lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:-]+$/, '')}.`
  }
  if (out && !/[.!?]$/.test(out)) out = `${out}.`
  return out
}
