/**
 * artifact-extract.ts — server side detection of canvas artifacts in an
 * assistant message (SPEC 7.4b, "Canvas (R2)").
 *
 * Pure functions: no database, no filesystem, no Express. The detection lives
 * on the server (and not in the Android app or the web app) so that every
 * renderer sees the exact same artifact set instead of re-implementing a
 * markdown parser three times with three different bugs.
 *
 * Two sources, in the order of preference the SPEC gives:
 *   1. an uploaded file referenced by the message (`/api/uploads/…`, html, svg, png)
 *   2. a fenced ```html / ```svg block in the message text
 *
 * The fence is NEVER removed from the message text: Telegram and the web
 * fallback have to keep rendering the raw block, and a stripped message would
 * make the strand unreadable on every surface that has no canvas.
 */
import type { UploadDescriptor } from './uploads.js'

export type ArtifactKind = 'html' | 'svg' | 'image'
export type ArtifactSource = 'inline_fence' | 'upload'

/**
 * Hard ceiling for one artifact. A hallucinated 50 MB HTML page must not reach
 * a phone: it would blow up the WebView, the response and the backup. Chosen
 * conservatively — a self contained page with inline CSS/JS and a bit of data
 * stays far below this.
 */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

/** Ceiling per message, so one runaway answer cannot create a gallery. */
export const MAX_ARTIFACTS_PER_MESSAGE = 4

/** Longest title we persist; anything longer is cut (never rejected). */
export const ARTIFACT_TITLE_MAX = 120

const UPLOAD_MIME_KINDS: Record<string, ArtifactKind> = {
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'image/png': 'image',
}

const UPLOAD_EXTENSION_KINDS: Record<string, ArtifactKind> = {
  html: 'html',
  htm: 'html',
  svg: 'svg',
  png: 'image',
}

const EXTENSION_MIME: Record<ArtifactKind, string> = {
  html: 'text/html',
  svg: 'image/svg+xml',
  image: 'image/png',
}

export interface FencedBlock {
  /** Info string of the opening fence, trimmed (`html Kalkulator`). */
  info: string
  /** First word of the info string, lower cased (`html`). */
  language: string
  /** Everything after the first word of the info string, trimmed. */
  infoRest: string
  /** Block body without the fence lines and without a trailing newline. */
  body: string
}

/** A fence we would turn into an artifact if nothing else stops us. */
export interface InlineArtifactCandidate {
  source: 'inline_fence'
  kind: Extract<ArtifactKind, 'html' | 'svg'>
  title: string
  body: string
  mimeType: string
  size: number
}

/** An upload referenced by the message that the canvas can render. */
export interface UploadArtifactCandidate {
  source: 'upload'
  kind: ArtifactKind
  title: string
  relativePath: string
  mimeType: string
}

export type ArtifactCandidate = InlineArtifactCandidate | UploadArtifactCandidate

/**
 * Split markdown into its top level fenced blocks (CommonMark rules, reduced
 * to what a chat message can realistically contain).
 *
 * - a fence opens with at least three backticks or tildes, indented at most
 *   three spaces
 * - it closes with a fence of the SAME character and at least the same length
 *   that carries nothing else on its line
 * - everything between the two is body, including fences of a shorter run, so
 *   a ````…```` wrapper that demonstrates a ```html block yields ONE block
 *   (the wrapper) and not a nested one
 * - an opening fence that is never closed yields NOTHING: a truncated or
 *   malformed block is ambiguous, and guessing where it ends is how you ship
 *   half an HTML page as an artifact
 */
export function parseFencedBlocks(text: string): FencedBlock[] {
  if (!text) return []
  const lines = text.split('\n')
  const blocks: FencedBlock[] = []

  let open: { char: string; length: number; info: string; body: string[] } | null = null

  for (const line of lines) {
    if (open) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1][0] === open.char && closing[1].length >= open.length) {
        blocks.push(toFencedBlock(open.info, open.body.join('\n')))
        open = null
        continue
      }
      open.body.push(line)
      continue
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/)
    if (!opening) continue
    const marker = opening[1]
    const info = opening[2].trim()
    // A backtick fence may not carry a backtick in its info string.
    if (marker[0] === '`' && info.includes('`')) continue
    open = { char: marker[0], length: marker.length, info, body: [] }
  }

  // `open !== null` here means an unterminated fence — deliberately dropped.
  return blocks
}

function toFencedBlock(info: string, body: string): FencedBlock {
  const firstSpace = info.search(/\s/)
  const language = (firstSpace === -1 ? info : info.slice(0, firstSpace)).toLowerCase()
  const infoRest = firstSpace === -1 ? '' : info.slice(firstSpace).trim()
  return { info, language, infoRest, body }
}

/** Collapse whitespace, drop control characters, cut to the column limit. */
export function sanitizeArtifactTitle(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const value = cleaned || fallback
  return value.length > ARTIFACT_TITLE_MAX ? value.slice(0, ARTIFACT_TITLE_MAX).trim() : value
}

/** `<title>` of an HTML document, else its first `<h1>`, else null. */
export function titleFromMarkup(body: string): string | null {
  const title = body.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  if (title) {
    const text = title[1].replace(/<[^>]*>/g, ' ').trim()
    if (text) return text
  }
  const heading = body.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i)
  if (heading) {
    const text = heading[1].replace(/<[^>]*>/g, ' ').trim()
    if (text) return text
  }
  return null
}

/**
 * The ```html / ```svg blocks of a message, in document order.
 *
 * The title comes from the info string when the persona wrote one
 * (```html Rendite Rechner), mirroring the ```snippet convention from
 * SPEC 7.4b, otherwise from the markup, otherwise from the kind.
 */
export function extractInlineArtifacts(content: string): InlineArtifactCandidate[] {
  const out: InlineArtifactCandidate[] = []
  for (const block of parseFencedBlocks(content)) {
    const kind = block.language === 'html' ? 'html' : block.language === 'svg' ? 'svg' : null
    if (!kind) continue
    if (!block.body.trim()) continue
    const fallback = kind === 'html' ? 'HTML artifact' : 'SVG artifact'
    out.push({
      source: 'inline_fence',
      kind,
      title: sanitizeArtifactTitle(block.infoRest || titleFromMarkup(block.body), fallback),
      body: block.body,
      mimeType: EXTENSION_MIME[kind],
      size: Buffer.byteLength(block.body, 'utf8'),
    })
  }
  return out
}

function normalizeUploadPath(raw: string): string | null {
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // A malformed escape stays as written; the storage layer rejects it later.
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return null
  return normalized
}

function kindFromPath(relativePath: string): ArtifactKind | null {
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? ''
  return UPLOAD_EXTENSION_KINDS[ext] ?? null
}

/**
 * Uploads this message points at that the canvas can render.
 *
 * Two ways in, because both happen in practice: the descriptors a message
 * carries in its `metadata` (a tool attached a file) and a plain
 * `/api/uploads/…` URL in the text (a persona linked one).
 */
export function extractUploadArtifacts(
  content: string,
  uploads: UploadDescriptor[] = [],
): UploadArtifactCandidate[] {
  const seen = new Set<string>()
  const out: UploadArtifactCandidate[] = []

  for (const file of uploads) {
    if (!file || typeof file.relativePath !== 'string') continue
    const relativePath = normalizeUploadPath(file.relativePath)
    if (!relativePath || seen.has(relativePath)) continue
    const kind = UPLOAD_MIME_KINDS[(file.mimeType ?? '').toLowerCase()] ?? kindFromPath(relativePath)
    if (!kind) continue
    seen.add(relativePath)
    out.push({
      source: 'upload',
      kind,
      title: sanitizeArtifactTitle(file.originalName, `${kind.toUpperCase()} artifact`),
      relativePath,
      mimeType: EXTENSION_MIME[kind],
    })
  }

  const urlPattern = /\/api\/uploads\/([A-Za-z0-9._~%/-]+\.(?:html?|svg|png))/gi
  for (const match of content.matchAll(urlPattern)) {
    const relativePath = normalizeUploadPath(match[1])
    if (!relativePath || seen.has(relativePath)) continue
    const kind = kindFromPath(relativePath)
    if (!kind) continue
    seen.add(relativePath)
    out.push({
      source: 'upload',
      kind,
      title: sanitizeArtifactTitle(relativePath.split('/').pop(), `${kind.toUpperCase()} artifact`),
      relativePath,
      mimeType: EXTENSION_MIME[kind],
    })
  }

  return out
}

/**
 * Everything in one message that should become an artifact, uploads first
 * (SPEC order of preference), capped at {@link MAX_ARTIFACTS_PER_MESSAGE}.
 *
 * Size is NOT filtered here — the caller decides what to do with an oversized
 * candidate so it can be reported instead of silently vanishing.
 */
export function extractArtifactCandidates(
  content: string,
  uploads: UploadDescriptor[] = [],
): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [
    ...extractUploadArtifacts(content ?? '', uploads),
    ...extractInlineArtifacts(content ?? ''),
  ]
  return candidates.slice(0, MAX_ARTIFACTS_PER_MESSAGE)
}

export function artifactMimeType(kind: ArtifactKind): string {
  return EXTENSION_MIME[kind]
}

export function artifactFileExtension(kind: ArtifactKind): string {
  return kind === 'html' ? 'html' : kind === 'svg' ? 'svg' : 'png'
}
