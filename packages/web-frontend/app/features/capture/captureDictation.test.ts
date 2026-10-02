import { describe, expect, it } from 'vitest'
import { appendTranscript, dictationFields, isDictatedCapture, markAfterEdit, markAfterTranscript, DICTATED_CAPTURE_KIND } from './captureDictation'

describe('capture dictation (pure)', () => {
  it('appends the transcript after the existing text, never replacing it', () => {
    expect(appendTranscript('', 'Synthetic words.')).toBe('Synthetic words.')
    expect(appendTranscript('Typed first', 'then spoken.')).toBe('Typed first then spoken.')
    expect(appendTranscript('Typed first ', 'then spoken.')).toBe('Typed first then spoken.')
    expect(appendTranscript('Line one\n', 'line two')).toBe('Line one\nline two')
    expect(appendTranscript('Keep me', '   ')).toBe('Keep me')
    expect(appendTranscript('Keep me', '  padded  ')).toBe('Keep me padded')
  })

  it('sets the mark only when a non blank transcript went in', () => {
    expect(markAfterTranscript(false, 'words')).toBe(true)
    expect(markAfterTranscript(false, '  ')).toBe(false)
    expect(markAfterTranscript(true, '')).toBe(true)
  })

  it('keeps the mark while editing and resets it when the box is emptied completely', () => {
    expect(markAfterEdit(true, 'edited dictation')).toBe(true)
    expect(markAfterEdit(true, '')).toBe(false)
    expect(markAfterEdit(true, ' \n\t ')).toBe(false)
    expect(markAfterEdit(false, 'typed')).toBe(false)
  })

  it('sends kind voice for a dictated capture and nothing extra for a typed one', () => {
    expect(DICTATED_CAPTURE_KIND).toBe('voice')
    expect(dictationFields(true)).toEqual({ kind: 'voice' })
    expect(dictationFields(false)).toEqual({})
    expect(Object.keys(dictationFields(true))).toEqual(['kind'])
  })

  it('recognises dictated captures in a list', () => {
    expect(isDictatedCapture({ kind: 'voice' })).toBe(true)
    expect(isDictatedCapture({ kind: 'text' })).toBe(false)
    expect(isDictatedCapture({})).toBe(false)
    expect(isDictatedCapture({ kind: null })).toBe(false)
  })
})
