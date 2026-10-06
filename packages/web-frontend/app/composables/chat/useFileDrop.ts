import { ref } from 'vue'

type TransferLike = Pick<DataTransfer, 'types'> & {
  files?: ArrayLike<File> | null
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null
  getData?(format: string): string
}

/** True when a drag or paste carries files (all of Chromium, Firefox and Safari report 'Files'). */
export function transferHasFiles(transfer: TransferLike | null | undefined): boolean {
  const types = transfer?.types
  return !!types && Array.from(types).includes('Files')
}

/**
 * The files of a DataTransfer (drop) or clipboard (paste). `files` is the
 * common path; `items` covers browsers that only expose a pasted image there.
 */
export function filesFromTransfer(transfer: TransferLike | null | undefined): File[] {
  if (!transfer) return []
  const files = Array.from(transfer.files ?? [])
  if (files.length > 0) return files
  const out: File[] = []
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  return out
}

/**
 * A file manager may provide both a real file and the filename as plain text;
 * that filename is not the user's intended message. Conversely, Office often
 * provides meaningful text alongside a rendered image: preserve that text.
 * HTML with an image and an accompanying file is an image copy, not text.
 */
export function pasteIntent(transfer: TransferLike | null | undefined): { kind: 'text' } | { kind: 'files'; files: File[] } {
  // Read files synchronously inside the paste handler: Chromium's clipboard
  // items can lose their getAsFile() payload after the event returns.
  const files = filesFromTransfer(transfer)
  if (files.length === 0) return { kind: 'text' }
  const text = (transfer?.getData?.('text/plain') ?? '').trim()
  const html = transfer?.getData?.('text/html') ?? ''
  const names = files.map(file => file.name).filter(Boolean)
  const copiedNames = text.split(/\r?\n/).map(line => {
    const value = line.trim().replace(/^file:\/\//i, '')
    const basename = value.split(/[\\/]/).pop() ?? ''
    try { return decodeURIComponent(basename) } catch { return basename }
  })
  const textIsFilenames = copiedNames.length > 0 && copiedNames.every(name => names.includes(name))
  // In a web image copy Chromium can offer a plain URL/alt text as well as
  // text/html + image/png. A table copied from Office must still paste as text.
  const htmlIsImage = files.every(file => file.type.startsWith('image/'))
    && /<img\b/i.test(html) && !/<table\b/i.test(html)
  if (text && !textIsFilenames && !htmlIsImage) return { kind: 'text' }
  return { kind: 'files', files }
}

/**
 * Drag & drop file upload onto the chat column; dropped files go to `onFiles`.
 * A counter tracks dragenter/dragleave because those events bubble up through
 * every child element, which would otherwise make the overlay flicker on/off
 * whenever the cursor crosses a nested boundary.
 *
 * Only file drags are taken over (W6c): a text drag keeps the browser's own
 * behaviour, so dropping selected text into the composer inserts it.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const isDraggingFiles = ref(false)
  const dragCounter = ref(0)
  /** Last attached count, for the polite live region next to the drop zone. */
  const lastDropped = ref(0)

  function handleDragEnter(event: DragEvent) {
    if (!transferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragCounter.value++
    isDraggingFiles.value = true
    lastDropped.value = 0
  }
  function handleDragOver(event: DragEvent) {
    if (!transferHasFiles(event.dataTransfer)) return
    // Accept the drop (and keep the browser from opening the file in the tab).
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  function handleDragLeave(event: DragEvent) {
    if (!transferHasFiles(event.dataTransfer)) return
    dragCounter.value = Math.max(0, dragCounter.value - 1)
    if (dragCounter.value === 0) isDraggingFiles.value = false
  }
  function handleDrop(event: DragEvent) {
    dragCounter.value = 0
    isDraggingFiles.value = false
    if (!transferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    const files = filesFromTransfer(event.dataTransfer)
    if (files.length === 0) return
    lastDropped.value = files.length
    onFiles(files)
  }

  return { isDraggingFiles, lastDropped, handleDragEnter, handleDragOver, handleDragLeave, handleDrop }
}
