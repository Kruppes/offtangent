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
 * What a paste into the composer does (W6c). Text wins whenever the clipboard
 * carries text: an office app puts a rendered picture next to the copied cells,
 * and the user meant the text. Files are attached only when there is no text
 * (a screenshot, an image copied from a page or a file copied in the file
 * manager); then the default insertion has to be stopped.
 */
export function pasteIntent(transfer: TransferLike | null | undefined): { kind: 'text' } | { kind: 'files'; files: File[] } {
  const text = transfer?.getData?.('text/plain') ?? ''
  if (text.trim().length > 0) return { kind: 'text' }
  const files = filesFromTransfer(transfer)
  return files.length > 0 ? { kind: 'files', files } : { kind: 'text' }
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
