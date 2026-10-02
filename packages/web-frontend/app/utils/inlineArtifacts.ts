/**
 * Inline artifacts in the transcript (W4a): pure rules, no DOM.
 *
 * 1. `splitArtifactFences` — an answer whose ```html / ```svg block became an
 *    artifact shows that block ONCE, as the running artifact, with its source
 *    one click away. The fenced block is cut out of the markdown. The fence
 *    rules mirror `parseFencedBlocks` in core (`artifact-extract.ts`) so the
 *    n-th eligible fence here is the n-th inline artifact the server stored;
 *    when the counts disagree (a block was too large and skipped), nothing is
 *    cut: showing a block twice is better than losing one.
 * 2. `visibleArtifacts` — an uploaded image that is also an image attachment
 *    of the same message is shown once, by the attachment.
 * 3. `nextFrameState` — the lazy window of the sandboxed frames: mount when
 *    the placeholder comes near the viewport, unmount when it is far away,
 *    with a gap between the two margins so a frame does not flap at the edge.
 */

/** Minimal shape of an artifact reference (see `api/artifacts.ts`). */
export interface ArtifactLike {
  kind: string
  title: string
  source: string
  viewKey?: string | null
}

/** Minimal shape of a message attachment (see `useChat.ts`). */
export interface AttachmentLike {
  kind: string
  originalName: string
}

export interface ArtifactFence {
  /** `html` or `svg`. */
  language: 'html' | 'svg'
  /** Block body without the fence lines. */
  body: string
}

export interface SplitFences {
  /** The markdown with the artifact fences cut out. */
  text: string
  /** Bodies of the cut fences, in document order (index = inline artifact index). */
  fences: ArtifactFence[]
}

interface RawFence { start: number; end: number; language: string; body: string }

/** Top level fenced blocks with their line range (same rules as core). */
function fencedBlocks(lines: string[]): RawFence[] {
  const blocks: RawFence[] = []
  let open: { char: string; length: number; info: string; start: number; body: string[] } | null = null
  lines.forEach((line, index) => {
    if (open) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1]![0] === open.char && closing[1]!.length >= open.length) {
        const firstSpace = open.info.search(/\s/)
        const language = (firstSpace === -1 ? open.info : open.info.slice(0, firstSpace)).toLowerCase()
        blocks.push({ start: open.start, end: index, language, body: open.body.join('\n') })
        open = null
        return
      }
      open.body.push(line)
      return
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/)
    if (!opening) return
    const marker = opening[1]!
    const info = opening[2]!.trim()
    if (marker[0] === '`' && info.includes('`')) return
    open = { char: marker[0]!, length: marker.length, info, start: index, body: [] }
  })
  return blocks
}

/** Fences that core turns into an inline artifact: html/svg with a non-empty body. */
function artifactFences(lines: string[]): RawFence[] {
  return fencedBlocks(lines).filter(block => (block.language === 'html' || block.language === 'svg') && block.body.trim().length > 0)
}

/**
 * Cut the fences that became inline artifacts out of `content`.
 * `inlineCount` is the number of `inline_fence` artifacts of the message.
 */
export function splitArtifactFences(content: string, inlineCount: number): SplitFences {
  if (!content || inlineCount <= 0) return { text: content ?? '', fences: [] }
  const lines = content.split('\n')
  const fences = artifactFences(lines)
  if (fences.length !== inlineCount) return { text: content, fences: [] }
  const drop = new Set<number>()
  for (const fence of fences) for (let i = fence.start; i <= fence.end; i++) drop.add(i)
  const text = lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, fences: fences.map(fence => ({ language: fence.language as 'html' | 'svg', body: fence.body })) }
}

/** Number of inline (fenced) artifacts of a message. */
export function inlineArtifactCount(artifacts: readonly ArtifactLike[] | undefined): number {
  return (artifacts ?? []).filter(artifact => artifact.source === 'inline_fence').length
}

const normalizeName = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The artifacts a message shows as frames or trail lines. An uploaded image
 * (no living view) that is already an image attachment of the message is
 * dropped: the attachment shows it, a second 540 px frame was noise.
 */
export function visibleArtifacts<T extends ArtifactLike>(artifacts: readonly T[] | undefined, attachments: readonly AttachmentLike[] | undefined): T[] {
  const images = new Set((attachments ?? []).filter(a => a.kind === 'image').map(a => normalizeName(a.originalName)))
  return (artifacts ?? []).filter(artifact => {
    if (artifact.viewKey) return true
    if (artifact.kind === 'html' || artifact.kind === 'svg') return true
    if (artifact.source !== 'upload') return true
    return !images.has(normalizeName(artifact.title))
  })
}

/** The lazy frame: placeholder (never near yet), running, or unloaded again. */
export type FrameState = 'idle' | 'active' | 'parked'

/**
 * Next state of one frame from two observations:
 * `near` — the placeholder intersects the viewport grown by the mount margin;
 * `inKeepZone` — it still intersects the (larger) keep margin.
 */
export function nextFrameState(current: FrameState, near: boolean, inKeepZone: boolean): FrameState {
  if (near) return 'active'
  if (current === 'active' && !inKeepZone) return 'parked'
  return current
}

/** Margins of the lazy window, in px around the viewport. */
export const FRAME_MOUNT_MARGIN_PX = 200
export const FRAME_KEEP_MARGIN_PX = 1200
/** Height of an inline frame (and of its placeholder: no layout jump). */
export const FRAME_HEIGHT_PX = 480
