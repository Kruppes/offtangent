import { ref } from 'vue'

function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  if (!types) return false
  // Different browsers report 'Files' in slightly different ways; a plain
  // includes check works for all of Chromium, Firefox and Safari.
  return Array.from(types).includes('Files')
}

/**
 * Drag & drop file upload onto the chat column; dropped files go to `onFiles`.
 * A counter tracks dragenter/dragleave because those events bubble up through
 * every child element, which would otherwise make the overlay flicker on/off
 * whenever the cursor crosses a nested boundary.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const isDraggingFiles = ref(false)
  const dragCounter = ref(0)

  function handleDragEnter(event: DragEvent) {
    if (!dragHasFiles(event)) return
    dragCounter.value++
    isDraggingFiles.value = true
  }
  function handleDragOver(event: DragEvent) {
    if (!dragHasFiles(event)) return
    // Signal to the browser that we accept this drop (shows the "copy" cursor).
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  function handleDragLeave(event: DragEvent) {
    if (!dragHasFiles(event)) return
    dragCounter.value = Math.max(0, dragCounter.value - 1)
    if (dragCounter.value === 0) isDraggingFiles.value = false
  }
  function handleDrop(event: DragEvent) {
    dragCounter.value = 0
    isDraggingFiles.value = false
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0) return
    onFiles(files)
  }

  return { isDraggingFiles, handleDragEnter, handleDragOver, handleDragLeave, handleDrop }
}
