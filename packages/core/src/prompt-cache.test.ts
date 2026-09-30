import { describe, it, expect } from 'vitest'
import {
  SYSTEM_PROMPT_CACHE_MARKER,
  DEFAULT_PROMPT_CACHE_SETTINGS,
  resolvePromptCacheSettings,
  splitSystemPromptAtCacheMarker,
  applySystemPromptCacheBreakpoint,
  isAnthropicMessagesApi,
} from './prompt-cache.js'

describe('splitSystemPromptAtCacheMarker', () => {
  it('removes the marker and reports the prefix length', () => {
    const prompt = `<a>stable</a>\n\n${SYSTEM_PROMPT_CACHE_MARKER}\n\n<b>volatile</b>`

    const { text, prefixChars } = splitSystemPromptAtCacheMarker(prompt)

    // The transmitted prompt is byte-identical to an assembly without marker.
    expect(text).toBe('<a>stable</a>\n\n<b>volatile</b>')
    expect(text).not.toContain(SYSTEM_PROMPT_CACHE_MARKER)
    expect(prefixChars).toBe('<a>stable</a>\n\n'.length)
    expect(text.slice(0, prefixChars!)).toBe('<a>stable</a>\n\n')
    expect(text.slice(prefixChars!)).toBe('<b>volatile</b>')
  })

  it('passes a prompt without a marker through untouched', () => {
    const prompt = 'no marker here'
    const result = splitSystemPromptAtCacheMarker(prompt)
    expect(result.text).toBe(prompt)
    expect(result.prefixChars).toBeNull()
  })

  it('handles an undefined prompt', () => {
    expect(splitSystemPromptAtCacheMarker(undefined)).toEqual({ text: '', prefixChars: null })
  })

  it('refuses a marker that would produce an empty half', () => {
    expect(splitSystemPromptAtCacheMarker(`${SYSTEM_PROMPT_CACHE_MARKER}\n\nonly tail`).prefixChars).toBeNull()
    expect(splitSystemPromptAtCacheMarker(`only head\n\n${SYSTEM_PROMPT_CACHE_MARKER}`).prefixChars).toBeNull()
  })
})

describe('applySystemPromptCacheBreakpoint', () => {
  const cc = { type: 'ephemeral', ttl: '1h' }

  it('splits the system block in two and caches the stable prefix', () => {
    const text = 'STABLEPREFIX' + 'VOLATILETAIL'
    const payload = { model: 'claude', system: [{ type: 'text', text, cache_control: cc }], messages: [] }

    const out = applySystemPromptCacheBreakpoint(payload, 12, text.length) as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>
    }

    expect(out.system).toHaveLength(2)
    expect(out.system[0]).toEqual({ type: 'text', text: 'STABLEPREFIX', cache_control: cc })
    expect(out.system[1]).toEqual({ type: 'text', text: 'VOLATILETAIL', cache_control: cc })
    // The concatenated text is unchanged — the model sees the same prompt.
    expect(out.system.map(b => b.text).join('')).toBe(text)
  })

  it('keeps the total number of cache_control markers at 2 for OAuth payloads', () => {
    const text = 'STABLEPREFIXVOLATILETAIL'
    const payload = {
      system: [
        { type: 'text', text: 'You are Claude Code.', cache_control: cc },
        { type: 'text', text, cache_control: cc },
      ],
    }

    const out = applySystemPromptCacheBreakpoint(payload, 12, text.length) as {
      system: Array<{ text: string; cache_control?: unknown }>
    }

    expect(out.system).toHaveLength(3)
    // Anthropic allows 4 cache_control blocks in total (tools + last user
    // message take one each), so the identity block gives its marker up.
    expect(out.system.filter(b => b.cache_control !== undefined)).toHaveLength(2)
    expect(out.system[0].cache_control).toBeUndefined()
    expect(out.system[0].text).toBe('You are Claude Code.')
    expect(out.system.map(b => b.text).join('')).toBe('You are Claude Code.' + text)
  })

  it('bails out when the text length does not match the assembled prompt', () => {
    const payload = { system: [{ type: 'text', text: 'rewritten', cache_control: cc }] }
    expect(applySystemPromptCacheBreakpoint(payload, 3, 999)).toBeUndefined()
  })

  it('bails out when caching is disabled (no cache_control on the block)', () => {
    const payload = { system: [{ type: 'text', text: 'STABLEVOLATILE' }] }
    expect(applySystemPromptCacheBreakpoint(payload, 6, 14)).toBeUndefined()
  })

  it('bails out for payload shapes it does not understand', () => {
    expect(applySystemPromptCacheBreakpoint(undefined, 3, 3)).toBeUndefined()
    expect(applySystemPromptCacheBreakpoint({ system: 'plain string' }, 3, 12)).toBeUndefined()
    expect(applySystemPromptCacheBreakpoint({ system: [] }, 3, 3)).toBeUndefined()
    expect(applySystemPromptCacheBreakpoint({ system: [{ type: 'image' }] }, 3, 3)).toBeUndefined()
    // Offset outside the text
    expect(applySystemPromptCacheBreakpoint({ system: [{ type: 'text', text: 'abc', cache_control: cc }] }, 3, 3)).toBeUndefined()
    expect(applySystemPromptCacheBreakpoint({ system: [{ type: 'text', text: 'abc', cache_control: cc }] }, 0, 3)).toBeUndefined()
  })

  it('leaves every other payload field untouched', () => {
    const text = 'STABLEVOLATILE'
    const payload = { model: 'x', max_tokens: 4, tools: [{ name: 't' }], system: [{ type: 'text', text, cache_control: cc }] }
    const out = applySystemPromptCacheBreakpoint(payload, 6, text.length) as Record<string, unknown>
    expect(out.model).toBe('x')
    expect(out.max_tokens).toBe(4)
    expect(out.tools).toBe(payload.tools)
  })
})

describe('resolvePromptCacheSettings', () => {
  it('defaults to long retention with the system breakpoint on', () => {
    expect(resolvePromptCacheSettings(undefined)).toEqual(DEFAULT_PROMPT_CACHE_SETTINGS)
    expect(DEFAULT_PROMPT_CACHE_SETTINGS.retention).toBe('long')
    expect(DEFAULT_PROMPT_CACHE_SETTINGS.systemBreakpoint).toBe(true)
  })

  it('accepts valid overrides and ignores invalid ones', () => {
    expect(resolvePromptCacheSettings({ retention: 'short', systemBreakpoint: false, sessionAffinity: false })).toEqual({
      retention: 'short', systemBreakpoint: false, sessionAffinity: false,
    })
    expect(resolvePromptCacheSettings({ retention: 'forever', systemBreakpoint: 'yes' })).toEqual(DEFAULT_PROMPT_CACHE_SETTINGS)
  })
})

describe('isAnthropicMessagesApi', () => {
  it('matches only the Anthropic Messages API', () => {
    expect(isAnthropicMessagesApi('anthropic-messages')).toBe(true)
    expect(isAnthropicMessagesApi('openai-completions')).toBe(false)
    expect(isAnthropicMessagesApi(undefined)).toBe(false)
  })
})
