/**
 * canvas-write-tool.ts — `canvas_write`, the tool that writes into the canvas
 * of a strand instead of posting a message.
 *
 * ## Why its own tool and not another flag on `send_file_to_user`
 *
 * `send_file_to_user` already takes an optional `view_key`, and that is how the
 * living views of 0.27.0 were built. But the two tools mean different things:
 *
 *  - `send_file_to_user` hands the user a FILE. The chat keeps a card with a
 *    download button, the caption talks about the file, and a one-off letter or
 *    flyer is exactly what it is for.
 *  - `canvas_write` updates the WORK SURFACE of the strand. There is no
 *    download, the chat keeps one line, and the interesting parameters are the
 *    identity of the view (`key`), its display title and the half sentence the
 *    line shows. A path is an implementation detail of how the document got
 *    rendered.
 *
 * Overloading one tool with both meanings is what makes a model pick the wrong
 * one: the description would have to say "sometimes this posts a card and
 * sometimes it does not". So the tools are separate and the plumbing is shared
 * — `canvas_write` produces the same {@link UploadDescriptor} with a
 * `viewKey`, runs through the same delivery sink, and the same server side
 * extraction turns it into revision n+1. One view path, two doors.
 *
 * An invalid key is a tool error and never a silently dropped parameter: a
 * caller whose key was ignored would keep writing revisions that each land as
 * their own card without ever learning why.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { MAX_VIEW_NOTE_CHARS, normalizeViewKey, normalizeViewNote, sanitizeArtifactTitle } from './artifact-extract.js'
import { artifactViewEvents, type CanvasViewUpdate } from './artifact-view-events.js'
import type { SendFileDeliveryResult, SendFileToolOptions } from './send-file-tool.js'
import { saveUpload, type UploadDescriptor } from './uploads.js'
import { getWorkspaceDir } from './workspace.js'

/** What the tool result carries so channels can pick the document up. */
export interface CanvasWriteToolDetails {
  uploadedFile?: UploadDescriptor
  error?: boolean
  /** Row id of the message carrying the revision, when a sink delivered it. */
  messageId?: number
  /** View key the revision was written to. */
  viewKey?: string
  /** Revision number, when it was already assigned (sink path). */
  revision?: number
}

/** Documents the canvas can render. Mirrors `UPLOAD_EXTENSION_KINDS`. */
const CANVAS_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.png'])

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** Same ceiling as `send_file_to_user`; the artifact store caps again. */
const MAX_FILE_SIZE = 50 * 1024 * 1024

function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath
  return path.resolve(getWorkspaceDir(), inputPath)
}

function errorResult(text: string): { content: Array<{ type: 'text'; text: string }>; details: CanvasWriteToolDetails } {
  return { content: [{ type: 'text' as const, text }], details: { error: true } }
}

/**
 * Create the `canvas_write` tool.
 *
 * Takes the same options as `send_file_to_user` because it needs the same two
 * facts (who is the user, who persists the row) and nothing else.
 */
export function createCanvasWriteTool(options: SendFileToolOptions): AgentTool {
  return {
    name: 'canvas_write',
    label: 'Write to Canvas',
    description:
      'Write a document into the canvas of the current strand. The canvas is the work surface of a '
      + 'strand: use it for every result you update more than once (a wheel measurement, a dashboard, a '
      + 'report that gets a new round of numbers, a plan you keep revising). The same `key` written again '
      + 'becomes the next revision of ONE view, the older revisions stay readable, and the chat keeps a '
      + 'single line per update instead of a new card. Render the document first (write_file / a skill '
      + 'template plus JSON), then pass its path here. Allowed: html, svg and png. '
      + 'Use send_file_to_user instead for a one-off file the user downloads (a letter, a flyer, an '
      + 'archive). After a canvas_write your chat answer is ONE sentence, never a repeat of the content.',
    parameters: Type.Object({
      key: Type.String({
        description:
          'Stable key of the view inside this strand (lower case letters, digits and dashes, 2-40 '
          + 'characters, e.g. "front-wheel"). Writing the same key again creates revision n+1 of that '
          + 'view; a new key opens a second tab in the canvas.',
      }),
      title: Type.String({
        description:
          'Display title of the view, shown on the canvas rail and on its tab (e.g. "Wheel truing"). '
          + 'Keep it short: 2 to 40 characters read well on a phone.',
      }),
      path: Type.String({
        description:
          'Path to the rendered document, absolute or relative to the workspace dir. Must be an '
          + 'existing, non-empty .html, .svg or .png file.',
      }),
      summary: Type.Optional(
        Type.String({
          description:
            `Half sentence for the one line this update leaves in the chat (max ${MAX_VIEW_NOTE_CHARS} `
            + 'characters, e.g. "measure spoke 25 first"). Write the finding, not "the view was updated".',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { key: rawKey, title: rawTitle, path: inputPath, summary } = params as {
        key: string
        title: string
        path: string
        summary?: string
      }

      const userId = options.getCurrentToolUserId()
      if (userId === undefined || userId === null) {
        return errorResult('Error: canvas_write cannot be used without an active user.')
      }

      const viewKey = normalizeViewKey(rawKey)
      if (!viewKey) {
        return errorResult(
          `Error: invalid canvas key ${JSON.stringify(rawKey ?? null)}. Use 2 to 40 characters, lower case `
          + 'letters, digits and dashes, starting and ending alphanumeric (e.g. "front-wheel").',
        )
      }

      const title = sanitizeArtifactTitle(rawTitle, '')
      if (!title) {
        return errorResult('Error: canvas_write needs a non-empty title for the view (e.g. "Wheel truing").')
      }

      const note = normalizeViewNote(summary)

      let absolutePath: string
      try {
        absolutePath = resolvePath(inputPath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Error: failed to resolve path "${inputPath}": ${message}`)
      }

      const extension = path.extname(absolutePath).toLowerCase()
      if (!CANVAS_EXTENSIONS.has(extension)) {
        return errorResult(
          `Error: the canvas renders html, svg and png, not "${path.basename(absolutePath)}". `
          + 'Render the view as HTML and write that file.',
        )
      }

      let stat: fs.Stats
      try {
        stat = fs.statSync(absolutePath)
      } catch {
        return errorResult(`Error: file not found at "${absolutePath}".`)
      }
      if (!stat.isFile()) return errorResult(`Error: "${absolutePath}" is not a regular file.`)
      if (stat.size === 0) return errorResult(`Error: file "${absolutePath}" is empty.`)
      if (stat.size > MAX_FILE_SIZE) {
        return errorResult(`Error: file too large (${stat.size} bytes). Max allowed: ${MAX_FILE_SIZE} bytes.`)
      }

      let buffer: Buffer
      try {
        buffer = fs.readFileSync(absolutePath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Error reading "${absolutePath}": ${message}`)
      }

      const sessionId = options.getCurrentInteractiveSessionId?.() ?? null

      let uploaded: UploadDescriptor
      try {
        uploaded = saveUpload({
          buffer,
          originalName: path.basename(absolutePath),
          mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
          source: 'web',
          userId,
          sessionId,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Error storing the canvas document: ${message}`)
      }

      // Everything the view needs rides on the descriptor: it is the only
      // carrier all three writers of an assistant row hand to the artifact
      // extraction unchanged (see uploads.ts).
      uploaded.viewKey = viewKey
      uploaded.viewTitle = title
      if (note) uploaded.viewNote = note

      const carriedByTurn = options.isCarriedByCurrentTurn?.() === true

      if (carriedByTurn) {
        // The running turn persists the row (and with it the revision) when it
        // ends, so no revision number exists yet. Saying "revision 4" here
        // would be a guess.
        return {
          content: [{
            type: 'text' as const,
            text: `Canvas view "${viewKey}" (${title}) will be written with this turn`
              + `${note ? `, note: ${note}` : ''}. Keep your answer to one sentence.`,
          }],
          details: { uploadedFile: uploaded, viewKey } satisfies CanvasWriteToolDetails,
        }
      }

      if (!options.deliverFile) {
        return errorResult(
          `Error: the canvas document for "${viewKey}" was stored but NOT written to the strand: no live turn `
          + 'is persisting this conversation and no delivery channel is configured for this context. '
          + 'The user does not see the new revision.',
        )
      }

      // Capture the revision the store assigns, instead of counting rows here:
      // the number in the tool result is then the number the client sees.
      const seen: CanvasViewUpdate[] = []
      const unsubscribe = artifactViewEvents.onViewUpdate((update) => {
        if (update.userId === userId && update.viewKey === viewKey) seen.push(update)
      })

      let outcome: SendFileDeliveryResult
      try {
        outcome = await options.deliverFile({ userId, sessionId, upload: uploaded, caption: note ?? undefined })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Error writing the canvas view "${viewKey}": ${message}`)
      } finally {
        unsubscribe()
      }

      const messageId = Number(outcome?.messageId)
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return errorResult(
          `Error: writing the canvas view "${viewKey}" persisted no chat message `
          + `(sink returned ${JSON.stringify(outcome ?? null)}). The user does not see the new revision.`,
        )
      }

      const revision = seen[seen.length - 1]?.revision
      return {
        content: [{
          type: 'text' as const,
          text: revision
            ? `Canvas view "${viewKey}" (${title}) is now revision ${revision}`
              + `${note ? `, note: ${note}` : ''}. Keep your answer to one sentence.`
            : `Canvas view "${viewKey}" (${title}) was written to the strand (message ${messageId}). `
              + 'Keep your answer to one sentence.',
        }],
        details: {
          uploadedFile: uploaded,
          messageId,
          viewKey,
          ...(revision ? { revision } : {}),
        } satisfies CanvasWriteToolDetails,
      }
    },
  }
}
