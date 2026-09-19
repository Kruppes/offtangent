import { describe, expect, it } from 'vitest'
import { classifyPlaybackError, pickPlayableFormat, TTS_FORMAT_MIME } from './ttsPlayback'

/** `canPlayType` of a browser that decodes exactly the given MIME prefixes. */
function browser(...decodable: string[]) {
  return (mime: string) => (decodable.some(d => mime.startsWith(d)) ? 'probably' : '')
}

const chrome = browser('audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac')
const oldSafari = browser('audio/mpeg', 'audio/wav', 'audio/flac')

describe('pickPlayableFormat', () => {
  it('keeps the saved format where the browser decodes it', () => {
    expect(pickPlayableFormat('opus', 'gemini', chrome)).toBe('opus')
    expect(pickPlayableFormat('mp3', 'openai', chrome)).toBe('mp3')
  })

  it('falls back to WAV for Gemini in a Safari without Ogg/Opus', () => {
    // Gemini can only build opus or wav, mp3 is not on offer.
    expect(pickPlayableFormat('opus', 'gemini', oldSafari)).toBe('wav')
  })

  it('prefers mp3 over wav when the provider offers it', () => {
    expect(pickPlayableFormat('opus', 'openai', oldSafari)).toBe('mp3')
    expect(pickPlayableFormat('opus', 'deepgram', oldSafari)).toBe('mp3')
  })

  it('treats wav as playable even when canPlayType is silent about it', () => {
    const mute = () => ''
    expect(pickPlayableFormat('opus', 'gemini', mute)).toBe('wav')
    expect(pickPlayableFormat('wav', 'gemini', mute)).toBe('wav')
  })

  it('does not request a format the provider cannot build', () => {
    // A browser that only decodes mp3 gets wav from Gemini (always playable),
    // never mp3, which Gemini would answer with 400.
    expect(pickPlayableFormat('opus', 'gemini', browser('audio/mpeg'))).toBe('wav')
  })

  it('uses the generic order for an unknown provider', () => {
    expect(pickPlayableFormat('opus', undefined, oldSafari)).toBe('mp3')
    expect(pickPlayableFormat('opus', 'polly', chrome)).toBe('opus')
  })

  it('asks for opus with the codec parameter, the form Safari 18.4 answers', () => {
    expect(TTS_FORMAT_MIME.opus).toBe('audio/ogg; codecs="opus"')
  })
})

describe('classifyPlaybackError', () => {
  it('recognises the autoplay block so the UI can offer a second tap', () => {
    const err = new DOMException('play() failed', 'NotAllowedError')
    expect(classifyPlaybackError(err)).toEqual({ kind: 'blocked' })
  })

  it('recognises an undecodable stream from the promise and from MediaError', () => {
    expect(classifyPlaybackError(new DOMException('no', 'NotSupportedError'))).toEqual({ kind: 'unsupported' })
    expect(classifyPlaybackError({ code: 4 })).toEqual({ kind: 'unsupported' })
    expect(classifyPlaybackError({ code: 3 })).toEqual({ kind: 'unsupported' })
  })

  it('stays quiet about interruptions we caused ourselves', () => {
    expect(classifyPlaybackError(new DOMException('interrupted by pause()', 'AbortError'))).toEqual({ kind: 'aborted' })
    expect(classifyPlaybackError({ code: 1 })).toEqual({ kind: 'aborted' })
  })

  it('keeps the message for everything else', () => {
    expect(classifyPlaybackError(new Error('HTTP 500'))).toEqual({ kind: 'failed', message: 'HTTP 500' })
    expect(classifyPlaybackError({ code: 2 })).toEqual({ kind: 'failed', message: 'media error 2' })
    expect(classifyPlaybackError('nope')).toEqual({ kind: 'failed', message: 'nope' })
  })
})
