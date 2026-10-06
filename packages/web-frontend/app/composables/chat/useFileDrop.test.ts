import { describe, expect, it, vi } from 'vitest'
import { filesFromTransfer, pasteIntent, transferHasFiles, useFileDrop } from './useFileDrop'

// W6c: paste and drop into the composer. Synthetic transfers, no browser.
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'synthetic.png', { type: 'image/png' })
const txt = () => new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' })

function transfer(opts: { files?: File[]; itemsOnly?: File[]; text?: string }) {
  const types: string[] = []
  if (opts.text !== undefined) types.push('text/plain')
  if (opts.files?.length || opts.itemsOnly?.length) types.push('Files')
  return {
    types,
    files: opts.files ?? [],
    items: [
      ...(opts.text !== undefined ? [{ kind: 'string', getAsFile: () => null }] : []),
      ...(opts.files ?? opts.itemsOnly ?? []).map(f => ({ kind: 'file', getAsFile: () => f })),
    ],
    getData: (format: string) => (format === 'text/plain' ? opts.text ?? '' : ''),
    dropEffect: 'none',
  }
}
function dragEvent(type: string, t: ReturnType<typeof transfer>) {
  return { type, dataTransfer: t, preventDefault: vi.fn() } as unknown as DragEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('transfer helpers', () => {
  it('detects files and reads them from files or, as fallback, from items', () => {
    expect(transferHasFiles(transfer({ text: 'x' }))).toBe(false)
    expect(transferHasFiles(transfer({ files: [txt()] }))).toBe(true)
    expect(transferHasFiles(null)).toBe(false)
    expect(filesFromTransfer(transfer({ files: [txt(), png()] })).map(f => f.name)).toEqual(['synthetic.txt', 'synthetic.png'])
    expect(filesFromTransfer(transfer({ itemsOnly: [png()] })).map(f => f.name)).toEqual(['synthetic.png'])
    expect(filesFromTransfer(transfer({ text: 'only text' }))).toEqual([])
  })

  it('paste: text stays text, a bare image or file becomes an attachment, text wins over a riding picture', () => {
    expect(pasteIntent(transfer({ text: 'Synthetic words' }))).toEqual({ kind: 'text' })
    const img = pasteIntent(transfer({ files: [png()] }))
    expect(img.kind).toBe('files')
    expect(img.kind === 'files' && img.files[0]!.name).toBe('synthetic.png')
    expect(pasteIntent(transfer({ text: 'cell A1', files: [png()] }))).toEqual({ kind: 'text' })
    expect(pasteIntent(transfer({ text: '   ', files: [png()] })).kind).toBe('files')
    expect(pasteIntent(transfer({ text: 'synthetic.png', files: [png()] })).kind).toBe('files')
    expect(pasteIntent(transfer({ text: '/Users/example/Desktop/synthetic.png', files: [png()] })).kind).toBe('files')
    expect(pasteIntent(transfer({ text: 'file:///Users/example/Desktop/synthetic.png', files: [png()] })).kind).toBe('files')
    const pageImage = transfer({ text: 'Image alt text', files: [png()] })
    pageImage.getData = (format: string) => format === 'text/html' ? '<img src="https://example.invalid/p.png">' : 'Image alt text'
    expect(pasteIntent(pageImage).kind).toBe('files')
    pageImage.getData = (format: string) => format === 'text/html' ? '<table><tr><td><img src="x"></td></tr></table>' : 'Cell A1'
    expect(pasteIntent(pageImage)).toEqual({ kind: 'text' })
    expect(pasteIntent(null)).toEqual({ kind: 'text' })
  })
})

describe('useFileDrop', () => {
  it('takes over file drags only: zone on enter, off on leave, files to the callback on drop', () => {
    const onFiles = vi.fn()
    const d = useFileDrop(onFiles)
    const files = transfer({ files: [txt()] })
    const enter = dragEvent('dragenter', files)
    d.handleDragEnter(enter)
    expect(d.isDraggingFiles.value).toBe(true)
    expect(enter.preventDefault).toHaveBeenCalled()
    const over = dragEvent('dragover', files)
    d.handleDragOver(over)
    expect(over.preventDefault).toHaveBeenCalled()
    expect(files.dropEffect).toBe('copy')
    d.handleDragLeave(dragEvent('dragleave', files))
    expect(d.isDraggingFiles.value).toBe(false)
    d.handleDragEnter(dragEvent('dragenter', files))
    const drop = dragEvent('drop', files)
    d.handleDrop(drop)
    expect(drop.preventDefault).toHaveBeenCalled()
    expect(d.isDraggingFiles.value).toBe(false)
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'synthetic.txt' })])
    expect(d.lastDropped.value).toBe(1)
  })

  it('leaves a text drag to the browser (no preventDefault, no zone, no callback)', () => {
    const onFiles = vi.fn()
    const d = useFileDrop(onFiles)
    const text = transfer({ text: 'dropped words' })
    const events = ['dragenter', 'dragover', 'drop'].map(type => dragEvent(type, text))
    d.handleDragEnter(events[0]!)
    d.handleDragOver(events[1]!)
    d.handleDrop(events[2]!)
    for (const e of events) expect(e.preventDefault).not.toHaveBeenCalled()
    expect(d.isDraggingFiles.value).toBe(false)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('nested enter/leave pairs do not flicker the zone', () => {
    const d = useFileDrop(vi.fn())
    const files = transfer({ files: [txt()] })
    d.handleDragEnter(dragEvent('dragenter', files))
    d.handleDragEnter(dragEvent('dragenter', files))
    d.handleDragLeave(dragEvent('dragleave', files))
    expect(d.isDraggingFiles.value).toBe(true)
    d.handleDragLeave(dragEvent('dragleave', files))
    expect(d.isDraggingFiles.value).toBe(false)
  })
})
