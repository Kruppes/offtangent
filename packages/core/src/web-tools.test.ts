import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractTextFromHtml,
  stripInlineHtml,
  withRetry,
  BraveSearchError,
  TavilySearchError,
  parseDuckDuckGoLiteHtml,
  searchDuckDuckGo,
  searchBrave,
  searchSearXNG,
  searchTavily,
  resolveSearchProvider,
  encryptBraveApiKey,
  decryptBraveApiKey,
  encryptTavilyApiKey,
  decryptTavilyApiKey,
  createWebSearchTool,
  createWebFetchTool,
  createBuiltinWebTools,
} from './web-tools.js'
import { encrypt } from './encryption.js'

// ─── extractTextFromHtml ─────────────────────────────────────────────────────

describe('extractTextFromHtml', () => {
  it('strips simple HTML tags', () => {
    const html = '<p>Hello <b>world</b></p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Hello world')
  })

  it('removes script and style blocks', () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>alert("hi")</script>
          <p>Visible text</p>
          <script type="text/javascript">var x = 1;</script>
        </body>
      </html>
    `
    const text = extractTextFromHtml(html)
    expect(text).toContain('Visible text')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('var x')
  })

  it('removes HTML comments', () => {
    const html = '<p>Before</p><!-- secret comment --><p>After</p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Before')
    expect(text).toContain('After')
    expect(text).not.toContain('secret comment')
  })

  it('decodes HTML entities', () => {
    const html = '<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('& < > " \'')
  })

  it('converts block elements to newlines', () => {
    const html = '<div>Block 1</div><div>Block 2</div>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Block 1')
    expect(text).toContain('Block 2')
    // Should have newlines between blocks
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    expect(lines).toContain('Block 1')
    expect(lines).toContain('Block 2')
  })

  it('collapses excessive whitespace', () => {
    const html = '<p>  Too   many    spaces  </p>'
    const text = extractTextFromHtml(html)
    expect(text).toBe('Too many spaces')
  })

  it('collapses excessive newlines', () => {
    const html = '<p>Line 1</p>\n\n\n\n\n<p>Line 2</p>'
    const text = extractTextFromHtml(html)
    // Should not have more than 2 consecutive newlines
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('handles empty input', () => {
    expect(extractTextFromHtml('')).toBe('')
  })

  it('removes noscript blocks', () => {
    const html = '<noscript>Enable JS</noscript><p>Content</p>'
    const text = extractTextFromHtml(html)
    expect(text).not.toContain('Enable JS')
    expect(text).toContain('Content')
  })

  it('decodes numeric HTML entities', () => {
    const html = '<p>&#65;&#66;&#67;</p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('ABC')
  })
})

// ─── stripInlineHtml ─────────────────────────────────────────────────────────

describe('stripInlineHtml', () => {
  it('strips basic HTML tags', () => {
    expect(stripInlineHtml('<strong>bold text</strong>')).toBe('bold text')
  })

  it('strips multiple nested tags', () => {
    expect(stripInlineHtml('<em><strong>nested</strong> text</em>')).toBe('nested text')
  })

  it('decodes HTML entities', () => {
    expect(stripInlineHtml('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'')
  })

  it('normalizes whitespace', () => {
    expect(stripInlineHtml('  too   many   spaces  ')).toBe('too many spaces')
  })

  it('handles empty string', () => {
    expect(stripInlineHtml('')).toBe('')
  })

  it('returns plain text unchanged', () => {
    expect(stripInlineHtml('just plain text')).toBe('just plain text')
  })

  it('handles Brave-style snippet markup', () => {
    expect(stripInlineHtml('<strong>an open platform</strong> for building AI agents'))
      .toBe('an open platform for building AI agents')
  })

  it('decodes nbsp', () => {
    expect(stripInlineHtml('hello&nbsp;world')).toBe('hello world')
  })

  it('decodes numeric entities', () => {
    expect(stripInlineHtml('&#65;&#66;&#67;')).toBe('ABC')
  })
})

// ─── withRetry ───────────────────────────────────────────────────────────────

describe('withRetry', () => {
  const noDelay = async () => {}

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const { result, retries } = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10, delayFn: noDelay })
    expect(result).toBe('ok')
    expect(retries).toBe(0)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new BraveSearchError('rate limited', 429, 'rate_limit', true))
      .mockResolvedValue('ok')
    const delayFn = vi.fn().mockResolvedValue(undefined)

    const { result, retries } = await withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 100,
      shouldRetry: (err) => err instanceof BraveSearchError && err.retryable,
      delayFn,
    })
    expect(result).toBe('ok')
    expect(retries).toBe(1)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(delayFn).toHaveBeenCalledWith(100) // baseDelayMs * 2^0
  })

  it('applies exponential backoff delays', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new BraveSearchError('err', 500, 'server_error', true))
      .mockRejectedValueOnce(new BraveSearchError('err', 500, 'server_error', true))
      .mockResolvedValue('ok')
    const delayFn = vi.fn().mockResolvedValue(undefined)

    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      shouldRetry: (err) => err instanceof BraveSearchError && err.retryable,
      delayFn,
    })

    expect(delayFn).toHaveBeenCalledTimes(2)
    expect(delayFn).toHaveBeenNthCalledWith(1, 100)  // 100 * 2^0
    expect(delayFn).toHaveBeenNthCalledWith(2, 200)  // 100 * 2^1
  })

  it('throws after maxRetries exhausted', async () => {
    const error = new BraveSearchError('rate limited', 429, 'rate_limit', true)
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 10,
      shouldRetry: () => true,
      delayFn: noDelay,
    })).rejects.toThrow('rate limited')

    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('does not retry non-retryable errors', async () => {
    const error = new BraveSearchError('auth failed', 401, 'auth', false)
    const fn = vi.fn().mockRejectedValue(error)
    const delayFn = vi.fn().mockResolvedValue(undefined)

    await expect(withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 10,
      shouldRetry: (err) => err instanceof BraveSearchError && err.retryable,
      delayFn,
    })).rejects.toThrow('auth failed')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(delayFn).not.toHaveBeenCalled()
  })

  it('works with maxRetries=0 (no retry)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    await expect(withRetry(fn, { maxRetries: 0, baseDelayMs: 10, delayFn: noDelay })).rejects.toThrow('fail')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries all errors when shouldRetry is not provided', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok')

    const { result, retries } = await withRetry(fn, { maxRetries: 1, baseDelayMs: 10, delayFn: noDelay })
    expect(result).toBe('ok')
    expect(retries).toBe(1)
  })
})

// ─── parseDuckDuckGoLiteHtml ─────────────────────────────────────────────────

describe('parseDuckDuckGoLiteHtml', () => {
  const sampleHtml = `
    <table>
      <tr>
        <td>
          <a rel="nofollow" href="https://example.com/page1" class="result-link">Example Page 1</a>
        </td>
      </tr>
      <tr>
        <td class="result-snippet">This is the first result snippet.</td>
      </tr>
      <tr>
        <td>
          <a rel="nofollow" href="https://example.com/page2" class="result-link">Example Page 2</a>
        </td>
      </tr>
      <tr>
        <td class="result-snippet">This is the second result snippet.</td>
      </tr>
      <tr>
        <td>
          <a rel="nofollow" href="https://example.com/page3" class="result-link">Example Page 3</a>
        </td>
      </tr>
      <tr>
        <td class="result-snippet">Third snippet here.</td>
      </tr>
    </table>
  `

  it('parses results with title, url, and snippet', () => {
    const results = parseDuckDuckGoLiteHtml(sampleHtml, 10)
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({
      title: 'Example Page 1',
      url: 'https://example.com/page1',
      snippet: 'This is the first result snippet.',
    })
    expect(results[1]).toEqual({
      title: 'Example Page 2',
      url: 'https://example.com/page2',
      snippet: 'This is the second result snippet.',
    })
  })

  it('respects count limit', () => {
    const results = parseDuckDuckGoLiteHtml(sampleHtml, 2)
    expect(results).toHaveLength(2)
  })

  it('returns empty array for empty HTML', () => {
    const results = parseDuckDuckGoLiteHtml('<html></html>', 5)
    expect(results).toHaveLength(0)
  })

  it('decodes HTML entities in results', () => {
    const html = `
      <a rel="nofollow" href="https://example.com?a=1&amp;b=2" class="result-link">Title &amp; More</a>
      <td class="result-snippet">Snippet with &lt;code&gt;</td>
    `
    const results = parseDuckDuckGoLiteHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com?a=1&b=2')
    expect(results[0].title).toBe('Title & More')
    expect(results[0].snippet).toBe('Snippet with <code>')
  })

  it('handles missing snippets gracefully', () => {
    const html = `
      <a rel="nofollow" href="https://example.com" class="result-link">No Snippet</a>
    `
    const results = parseDuckDuckGoLiteHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toBe('')
  })

  it('parses results with single-quoted class attributes (real DDG Lite format)', () => {
    const html = `
      <table>
        <tr>
          <td>
            <a rel="nofollow" href="https://example.com/page1" class='result-link'>Single Quote Page</a>
          </td>
        </tr>
        <tr>
          <td class='result-snippet'>Single quote snippet.</td>
        </tr>
      </table>
    `
    const results = parseDuckDuckGoLiteHtml(html, 10)
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: 'Single Quote Page',
      url: 'https://example.com/page1',
      snippet: 'Single quote snippet.',
    })
  })

  it('parses mixed single and double quoted class attributes', () => {
    const html = `
      <a rel="nofollow" href="https://example.com/dq" class="result-link">Double Quoted</a>
      <td class="result-snippet">DQ snippet</td>
      <a rel="nofollow" href="https://example.com/sq" class='result-link'>Single Quoted</a>
      <td class='result-snippet'>SQ snippet</td>
    `
    const results = parseDuckDuckGoLiteHtml(html, 10)
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Double Quoted')
    expect(results[1].title).toBe('Single Quoted')
  })
})

// ─── searchDuckDuckGo ────────────────────────────────────────────────────────

describe('searchDuckDuckGo', () => {
  it('calls DuckDuckGo lite with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <a rel="nofollow" href="https://example.com" class="result-link">Test Result</a>
        <td class="result-snippet">Test snippet</td>
      `,
    })

    const results = await searchDuckDuckGo('test query', 5, mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://lite.duckduckgo.com/lite/')
    expect(options.method).toBe('POST')
    expect(options.body).toContain('q=test+query')

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Test Result')
  })

  it('throws on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    })

    await expect(searchDuckDuckGo('test', 5, mockFetch)).rejects.toThrow('HTTP 503')
  })

  it('returns empty array when no results found', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>No results</body></html>',
    })

    const results = await searchDuckDuckGo('asdfghjkl', 5, mockFetch)
    expect(results).toHaveLength(0)
  })
})

// ─── searchBrave ─────────────────────────────────────────────────────────────

describe('searchBrave', () => {
  it('calls Brave API with correct parameters and headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'Brave Result 1', url: 'https://example.com/1', description: 'First brave result' },
            { title: 'Brave Result 2', url: 'https://example.com/2', description: 'Second brave result' },
          ],
        },
      }),
    })

    const results = await searchBrave('test query', 'my-api-key', 5, mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search')
    expect(url).toContain('q=test+query')
    expect(url).toContain('count=5')
    expect(options.headers['X-Subscription-Token']).toBe('my-api-key')
    expect(options.method).toBe('GET')

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Brave Result 1',
      url: 'https://example.com/1',
      snippet: 'First brave result',
    })
  })

  it('throws BraveSearchError with auth category on 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })

    try {
      await searchBrave('test', 'bad-key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      const e = err as InstanceType<typeof BraveSearchError>
      expect(e.status).toBe(401)
      expect(e.category).toBe('auth')
      expect(e.retryable).toBe(false)
      expect(e.message).toContain('auth failed')
      expect(e.message).toContain('API key')
      expect(e.message).toContain('Unauthorized')
    }
  })

  it('throws BraveSearchError with rate_limit category on 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    })

    try {
      await searchBrave('test', 'key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      const e = err as InstanceType<typeof BraveSearchError>
      expect(e.status).toBe(429)
      expect(e.category).toBe('rate_limit')
      expect(e.retryable).toBe(true)
      expect(e.message).toContain('rate limited')
      expect(e.message).toContain('free plan')
    }
  })

  it('throws BraveSearchError with server_error category on 5xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    })

    try {
      await searchBrave('test', 'key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      const e = err as InstanceType<typeof BraveSearchError>
      expect(e.status).toBe(503)
      expect(e.category).toBe('server_error')
      expect(e.retryable).toBe(true)
      expect(e.message).toContain('server error')
      expect(e.message).toContain('Service Unavailable')
    }
  })

  it('includes response body details in error for unknown status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error": "forbidden"}',
    })

    try {
      await searchBrave('test', 'key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      const e = err as InstanceType<typeof BraveSearchError>
      expect(e.status).toBe(403)
      expect(e.category).toBe('unknown')
      expect(e.retryable).toBe(false)
      expect(e.message).toContain('{"error": "forbidden"}')
    }
  })

  it('handles missing response body gracefully in errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    })

    try {
      await searchBrave('test', 'bad-key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      const e = err as InstanceType<typeof BraveSearchError>
      expect(e.status).toBe(401)
      expect(e.message).toContain('auth failed')
      expect(e.message).not.toContain('Details:')
    }
  })

  it('strips HTML from result snippets', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'Test', url: 'https://example.com', description: '<strong>an open platform</strong> for building AI agents' },
          ],
        },
      }),
    })

    const results = await searchBrave('test', 'key', 5, mockFetch)
    expect(results[0].snippet).toBe('an open platform for building AI agents')
    expect(results[0].snippet).not.toContain('<strong>')
  })

  it('returns empty array when no web results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    })

    const results = await searchBrave('test', 'key', 5, mockFetch)
    expect(results).toHaveLength(0)
  })

  it('handles missing web field in response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    const results = await searchBrave('test', 'key', 5, mockFetch)
    expect(results).toHaveLength(0)
  })

  it('respects count limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'R1', url: 'https://1.com', description: 'S1' },
            { title: 'R2', url: 'https://2.com', description: 'S2' },
            { title: 'R3', url: 'https://3.com', description: 'S3' },
          ],
        },
      }),
    })

    const results = await searchBrave('test', 'key', 2, mockFetch)
    expect(results).toHaveLength(2)
  })

  it('handles missing fields in results gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: { results: [{ title: 'Only Title' }] },
      }),
    })

    const results = await searchBrave('test', 'key', 5, mockFetch)
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ title: 'Only Title', url: '', snippet: '' })
  })
})

// ─── searchSearXNG ───────────────────────────────────────────────────────────

describe('searchSearXNG', () => {
  it('calls SearXNG with correct URL and parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'SearX Result', url: 'https://example.com', content: 'SearX snippet' },
        ],
      }),
    })

    const results = await searchSearXNG('test query', 'https://searx.example.com', 5, mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('https://searx.example.com/search')
    expect(url).toContain('q=test+query')
    expect(url).toContain('format=json')

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: 'SearX Result',
      url: 'https://example.com',
      snippet: 'SearX snippet',
    })
  })

  it('strips trailing slash from URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await searchSearXNG('test', 'https://searx.example.com/', 5, mockFetch)

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('https://searx.example.com/search')
    expect(url).not.toContain('//search')
  })

  it('throws on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    })

    await expect(searchSearXNG('test', 'https://searx.example.com', 5, mockFetch)).rejects.toThrow('HTTP 502')
  })

  it('returns empty array when no results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    const results = await searchSearXNG('test', 'https://searx.example.com', 5, mockFetch)
    expect(results).toHaveLength(0)
  })

  it('handles missing results field', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    const results = await searchSearXNG('test', 'https://searx.example.com', 5, mockFetch)
    expect(results).toHaveLength(0)
  })

  it('respects count limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'R1', url: 'https://1.com', content: 'S1' },
          { title: 'R2', url: 'https://2.com', content: 'S2' },
          { title: 'R3', url: 'https://3.com', content: 'S3' },
        ],
      }),
    })

    const results = await searchSearXNG('test', 'https://searx.example.com', 2, mockFetch)
    expect(results).toHaveLength(2)
  })

  it('handles missing fields in results gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Only Title' }],
      }),
    })

    const results = await searchSearXNG('test', 'https://searx.example.com', 5, mockFetch)
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ title: 'Only Title', url: '', snippet: '' })
  })
})

// ─── searchTavily ──────────────────────────────────────────────────────────

describe('searchTavily', () => {
  it('calls Tavily API with correct body, auth header, and method', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'Tavily R1', url: 'https://example.com/1', content: 'First tavily result' },
          { title: 'Tavily R2', url: 'https://example.com/2', content: 'Second tavily result' },
        ],
      }),
    })

    const results = await searchTavily('test query', 'tvly-test-key', 5, mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.tavily.com/search')
    expect(options.method).toBe('POST')
    expect(options.headers['Authorization']).toBe('Bearer tvly-test-key')
    expect(options.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(options.body as string) as { query: string; max_results: number; search_depth: string }
    expect(body.query).toBe('test query')
    expect(body.max_results).toBe(5)
    expect(body.search_depth).toBe('basic')

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Tavily R1',
      url: 'https://example.com/1',
      snippet: 'First tavily result',
    })
  })

  it('throws TavilySearchError with auth category on 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })

    try {
      await searchTavily('test', 'bad-key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TavilySearchError)
      const e = err as InstanceType<typeof TavilySearchError>
      expect(e.status).toBe(401)
      expect(e.category).toBe('auth')
      expect(e.retryable).toBe(false)
      expect(e.message).toContain('auth failed')
      expect(e.message).toContain('API key')
      expect(e.message).toContain('Unauthorized')
    }
  })

  it('throws TavilySearchError with rate_limit category on 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    })

    try {
      await searchTavily('test', 'key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TavilySearchError)
      const e = err as InstanceType<typeof TavilySearchError>
      expect(e.status).toBe(429)
      expect(e.category).toBe('rate_limit')
      expect(e.retryable).toBe(true)
      expect(e.message).toContain('rate limited')
    }
  })

  it('throws TavilySearchError with server_error category on 5xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    })

    try {
      await searchTavily('test', 'key', 5, mockFetch)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TavilySearchError)
      const e = err as InstanceType<typeof TavilySearchError>
      expect(e.status).toBe(502)
      expect(e.category).toBe('server_error')
      expect(e.retryable).toBe(true)
      expect(e.message).toContain('server error')
      expect(e.message).toContain('Bad Gateway')
    }
  })

  it('returns empty array when no results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    const results = await searchTavily('test', 'key', 5, mockFetch)
    expect(results).toHaveLength(0)
  })

  it('handles missing results field gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    const results = await searchTavily('test', 'key', 5, mockFetch)
    expect(results).toHaveLength(0)
  })

  it('respects count limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'R1', url: 'https://1.com', content: 'S1' },
          { title: 'R2', url: 'https://2.com', content: 'S2' },
          { title: 'R3', url: 'https://3.com', content: 'S3' },
        ],
      }),
    })

    const results = await searchTavily('test', 'key', 2, mockFetch)
    expect(results).toHaveLength(2)
  })

  it('handles missing fields in results gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Only Title' }],
      }),
    })

    const results = await searchTavily('test', 'key', 5, mockFetch)
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ title: 'Only Title', url: '', snippet: '' })
  })

  it('forwards count to max_results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await searchTavily('test', 'key', 7, mockFetch)

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body as string) as { max_results: number }
    expect(body.max_results).toBe(7)
  })
})

// ─── resolveSearchProvider ──────────────────────────────────────────────────

describe('resolveSearchProvider', () => {
  it('defaults to duckduckgo with no config', () => {
    const resolved = resolveSearchProvider()
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toBeUndefined()
  })

  it('returns duckduckgo when explicitly requested', () => {
    const resolved = resolveSearchProvider({ provider: 'duckduckgo' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toBeUndefined()
  })

  it('returns brave when configured with API key', () => {
    const resolved = resolveSearchProvider({ provider: 'brave', braveSearchApiKey: 'test-key' })
    expect(resolved.provider).toBe('brave')
    expect(resolved.warning).toBeUndefined()
  })

  it('falls back to duckduckgo when brave has no API key', () => {
    const resolved = resolveSearchProvider({ provider: 'brave' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toContain('Brave Search')
    expect(resolved.warning).toContain('Falling back to DuckDuckGo')
  })

  it('falls back to duckduckgo when brave has empty API key', () => {
    const resolved = resolveSearchProvider({ provider: 'brave', braveSearchApiKey: '' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toContain('Falling back to DuckDuckGo')
  })

  it('returns searxng when configured with URL', () => {
    const resolved = resolveSearchProvider({ provider: 'searxng', searxngUrl: 'https://searx.example.com' })
    expect(resolved.provider).toBe('searxng')
    expect(resolved.warning).toBeUndefined()
  })

  it('falls back to duckduckgo when searxng has no URL', () => {
    const resolved = resolveSearchProvider({ provider: 'searxng' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toContain('SearXNG')
    expect(resolved.warning).toContain('Falling back to DuckDuckGo')
  })

  it('falls back to duckduckgo when searxng has empty URL', () => {
    const resolved = resolveSearchProvider({ provider: 'searxng', searxngUrl: '' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toContain('Falling back to DuckDuckGo')
  })

  it('decrypts encrypted brave API key', () => {
    const encryptedKey = encrypt('my-secret-key')
    const resolved = resolveSearchProvider({ provider: 'brave', braveSearchApiKey: encryptedKey })
    expect(resolved.provider).toBe('brave')
    expect(resolved.warning).toBeUndefined()
  })

  it('returns tavily when configured with API key', () => {
    const resolved = resolveSearchProvider({ provider: 'tavily', tavilyApiKey: 'tvly-test-key' })
    expect(resolved.provider).toBe('tavily')
    expect(resolved.warning).toBeUndefined()
  })

  it('falls back to duckduckgo when tavily has no API key', () => {
    const resolved = resolveSearchProvider({ provider: 'tavily' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toContain('Tavily Search')
    expect(resolved.warning).toContain('Falling back to DuckDuckGo')
  })

  it('falls back to duckduckgo when tavily has empty API key', () => {
    const resolved = resolveSearchProvider({ provider: 'tavily', tavilyApiKey: '' })
    expect(resolved.provider).toBe('duckduckgo')
    expect(resolved.warning).toContain('Falling back to DuckDuckGo')
  })

  it('decrypts encrypted tavily API key', () => {
    const encryptedKey = encrypt('tvly-secret-key')
    const resolved = resolveSearchProvider({ provider: 'tavily', tavilyApiKey: encryptedKey })
    expect(resolved.provider).toBe('tavily')
    expect(resolved.warning).toBeUndefined()
  })
})

// ─── encryptBraveApiKey / decryptBraveApiKey ───────────────────────────────

describe('encryptBraveApiKey / decryptBraveApiKey', () => {
  it('encrypts and decrypts API key round-trip', () => {
    const apiKey = 'BSAtest123456789' // gitleaks:allow -- synthetic test fixture
    const encrypted = encryptBraveApiKey(apiKey)
    expect(encrypted).not.toBe(apiKey)
    const decrypted = decryptBraveApiKey(encrypted)
    expect(decrypted).toBe(apiKey)
  })
})

// ─── encryptTavilyApiKey / decryptTavilyApiKey ─────────────────────────────

describe('encryptTavilyApiKey / decryptTavilyApiKey', () => {
  it('encrypts and decrypts API key round-trip', () => {
    const apiKey = 'tvly-test123456789' // gitleaks:allow -- synthetic test fixture
    const encrypted = encryptTavilyApiKey(apiKey)
    expect(encrypted).not.toBe(apiKey)
    const decrypted = decryptTavilyApiKey(encrypted)
    expect(decrypted).toBe(apiKey)
  })

  it('returns empty string for empty input', () => {
    expect(encryptTavilyApiKey('')).toBe('')
  })

  it('does not double-encrypt already encrypted keys', () => {
    const apiKey = 'tvly-already-secret'
    const encrypted = encryptTavilyApiKey(apiKey)
    const reEncrypted = encryptTavilyApiKey(encrypted)
    expect(reEncrypted).toBe(encrypted)
    expect(decryptTavilyApiKey(reEncrypted)).toBe(apiKey)
  })
})

// ─── createWebSearchTool ─────────────────────────────────────────────────────

describe('createWebSearchTool', () => {
  it('creates a tool with correct metadata', () => {
    const tool = createWebSearchTool()
    expect(tool.name).toBe('web_search')
    expect(tool.label).toBe('Web Search')
    expect(tool.description).toBeTruthy()
    expect(tool.execute).toBeInstanceOf(Function)
  })

  it('executes search and returns formatted results', async () => {
    // We need to mock the global fetch for this tool since it uses searchDuckDuckGo internally
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <a rel="nofollow" href="https://example.com" class="result-link">Example</a>
        <td class="result-snippet">Example snippet</td>
      `,
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool()
      const result = await tool.execute('test-id', { query: 'test' })

      expect(result.content[0].type).toBe('text')
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Example')
      expect(text).toContain('https://example.com')
      expect(result.details.count).toBe(1)
      expect(result.details.provider).toBe('duckduckgo')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles search errors gracefully', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool()
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Search failed')
      expect(text).toContain('Network error')
      expect(result.details.error).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to DuckDuckGo when Tavily fails after retries', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('api.tavily.com')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          text: async () => 'Rate limited',
        })
      }
      // DuckDuckGo fallback
      return Promise.resolve({
        ok: true,
        text: async () => `
          <a rel="nofollow" href="https://example.com" class="result-link">DDG Fallback</a>
          <td class="result-snippet">Fallback snippet</td>
        `,
      })
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool({
        provider: 'tavily',
        tavilyApiKey: 'tvly-test-key',
        retry: { maxRetries: 1, baseDelayMs: 1, delayFn: async () => {} },
      })
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('DDG Fallback')
      expect(text).toContain('DuckDuckGo fallback')
      expect(result.details.provider).toBe('duckduckgo')
      expect(result.details.fallback).toBe(true)
      expect(result.details.requestedProvider).toBe('tavily')
      expect(result.details.failureCategory).toBe('rate_limit')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries Tavily on retryable errors and succeeds on subsequent attempt', async () => {
    const originalFetch = globalThis.fetch
    let tavilyCallCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('api.tavily.com')) {
        tavilyCallCount++
        if (tavilyCallCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            text: async () => 'Server Error',
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { title: 'Tavily Result', url: 'https://example.com', content: 'Got it on retry' },
            ],
          }),
        })
      }
      return Promise.resolve({ ok: false, status: 500 })
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool({
        provider: 'tavily',
        tavilyApiKey: 'tvly-test-key',
        retry: { maxRetries: 2, baseDelayMs: 1, delayFn: async () => {} },
      })
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Tavily Result')
      expect(result.details.retries).toBe(1)
      expect(result.details.provider).toBe('tavily')
      expect(result.details.fallback).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to DuckDuckGo when Brave fails after retries', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('api.search.brave.com')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          text: async () => 'Rate limited',
        })
      }
      // DuckDuckGo fallback
      return Promise.resolve({
        ok: true,
        text: async () => `
          <a rel="nofollow" href="https://example.com" class="result-link">DDG Fallback</a>
          <td class="result-snippet">Fallback snippet</td>
        `,
      })
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool({
        provider: 'brave',
        braveSearchApiKey: 'test-key',
        retry: { maxRetries: 1, baseDelayMs: 1, delayFn: async () => {} },
      })
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('DDG Fallback')
      expect(text).toContain('DuckDuckGo fallback')
      expect(result.details.provider).toBe('duckduckgo')
      expect(result.details.fallback).toBe(true)
      expect(result.details.requestedProvider).toBe('brave')
      expect(result.details.failureCategory).toBe('rate_limit')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('includes retry count in metadata when retries occurred', async () => {
    const originalFetch = globalThis.fetch
    let braveCallCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('api.search.brave.com')) {
        braveCallCount++
        if (braveCallCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            text: async () => 'Server Error',
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            web: {
              results: [
                { title: 'Brave Result', url: 'https://example.com', description: 'Got it on retry' },
              ],
            },
          }),
        })
      }
      return Promise.resolve({ ok: false, status: 500 })
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool({
        provider: 'brave',
        braveSearchApiKey: 'test-key',
        retry: { maxRetries: 2, baseDelayMs: 1, delayFn: async () => {} },
      })
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Brave Result')
      expect(result.details.retries).toBe(1)
      expect(result.details.provider).toBe('brave')
      expect(result.details.fallback).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error with failureCategory when both Brave and fallback fail', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      })
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool({
        provider: 'brave',
        braveSearchApiKey: 'test-key',
        retry: { maxRetries: 0, baseDelayMs: 1, delayFn: async () => {} },
      })
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Search failed')
      expect(result.details.error).toBe(true)
      expect(result.details.failureCategory).toBe('rate_limit')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not retry for non-retryable Brave errors (401)', async () => {
    const originalFetch = globalThis.fetch
    let braveCallCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('api.search.brave.com')) {
        braveCallCount++
        return Promise.resolve({
          ok: false,
          status: 401,
          text: async () => 'Unauthorized',
        })
      }
      // DDG fallback
      return Promise.resolve({
        ok: true,
        text: async () => `
          <a rel="nofollow" href="https://example.com" class="result-link">DDG Result</a>
          <td class="result-snippet">DDG snippet</td>
        `,
      })
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool({
        provider: 'brave',
        braveSearchApiKey: 'test-key',
        retry: { maxRetries: 2, baseDelayMs: 1, delayFn: async () => {} },
      })
      await tool.execute('test-id', { query: 'test' })

      // Should only have called Brave once (no retries for 401)
      expect(braveCallCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns no results message when search yields nothing', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html></html>',
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool()
      const result = await tool.execute('test-id', { query: 'nonexistent' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('No results found')
      expect(result.details.count).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── createWebFetchTool ──────────────────────────────────────────────────────

describe('createWebFetchTool', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('creates a tool with correct metadata', () => {
    const tool = createWebFetchTool()
    expect(tool.name).toBe('web_fetch')
    expect(tool.label).toBe('Web Fetch')
    expect(tool.description).toBeTruthy()
    expect(tool.execute).toBeInstanceOf(Function)
  })

  it('fetches and extracts text from HTML', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/html']]) as unknown as Headers,
      text: async () => '<html><body><h1>Hello</h1><p>World</p><script>bad()</script></body></html>',
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Hello')
      expect(text).toContain('World')
      expect(text).not.toContain('bad()')
      expect(result.details.truncated).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns plain text as-is for non-HTML content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      text: async () => 'Just plain text content',
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com/file.txt' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toBe('Just plain text content')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('respects maxLength truncation', async () => {
    const longContent = 'A'.repeat(1000)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      text: async () => longContent,
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com', maxLength: 100 })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text.length).toBeLessThan(1000)
      expect(text).toContain('[Content truncated at 100 characters]')
      expect(result.details.truncated).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses default maxLength of 50000', async () => {
    const longContent = 'B'.repeat(60000)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      text: async () => longContent,
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('[Content truncated at 50000 characters]')
      expect(result.details.truncated).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles HTTP errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Map() as unknown as Headers,
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com/missing' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('HTTP 404')
      expect(result.details.error).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Failed to fetch URL')
      expect(text).toContain('ECONNREFUSED')
      expect(result.details.error).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── createBuiltinWebTools ───────────────────────────────────────────────────

describe('createBuiltinWebTools', () => {
  it('creates both tools by default (no config)', () => {
    const tools = createBuiltinWebTools()
    expect(tools).toHaveLength(2)
    expect(tools.map(t => t.name)).toEqual(['web_search', 'web_fetch'])
  })

  it('creates both tools when both enabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'duckduckgo' },
      webFetch: { enabled: true },
    })
    expect(tools).toHaveLength(2)
  })

  it('excludes web_search when disabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: false },
      webFetch: { enabled: true },
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_fetch')
  })

  it('excludes web_fetch when disabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true },
      webFetch: { enabled: false },
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  it('excludes both when both disabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: false },
      webFetch: { enabled: false },
    })
    expect(tools).toHaveLength(0)
  })

  it('handles partial config (only webSearch)', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true },
    })
    expect(tools).toHaveLength(2) // webFetch defaults to enabled
  })

  it('handles empty config object', () => {
    const tools = createBuiltinWebTools({})
    expect(tools).toHaveLength(2) // Both default to enabled
  })

  it('passes braveSearchApiKey and searxngUrl to search tool', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'brave', braveSearchApiKey: 'test-key' },
    })
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('web_search')
  })

  it('passes searxng config to search tool', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'searxng', searxngUrl: 'https://searx.example.com' },
    })
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('web_search')
  })

  it('passes tavily config to search tool', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'tavily', tavilyApiKey: 'tvly-test' },
    })
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('web_search')
  })

  it('falls back to duckduckgo when tavily configured without API key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'tavily' },
    })
    expect(tools).toHaveLength(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Falling back to DuckDuckGo'))
    warnSpy.mockRestore()
  })

  it('falls back to duckduckgo when brave configured without API key', () => {
    // Should not throw, should fall back gracefully
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'brave' },
    })
    expect(tools).toHaveLength(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Falling back to DuckDuckGo'))
    warnSpy.mockRestore()
  })

  it('re-resolves web_search provider on every call when config is a getter (hot-reload)', async () => {
    let currentProvider: 'duckduckgo' | 'tavily' = 'duckduckgo'
    const tools = createBuiltinWebTools(() => ({
      webSearch: {
        enabled: true,
        provider: currentProvider,
        tavilyApiKey: 'tvly-test-key',
      },
      webFetch: { enabled: true },
    }))
    const webSearch = tools.find(t => t.name === 'web_search')!

    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      calls.push(typeof url === 'string' ? url : String(url))
      if (typeof url === 'string' && url.includes('api.tavily.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { title: 'Tavily Hit', url: 'https://example.com/tav', content: 'tav snippet' },
            ],
          }),
        })
      }
      // DuckDuckGo HTML lite response
      return Promise.resolve({
        ok: true,
        text: async () => `
          <a rel="nofollow" href="https://example.com/ddg" class="result-link">DDG Hit</a>
          <td class="result-snippet">ddg snippet</td>
        `,
      })
    }) as unknown as typeof fetch

    try {
      const r1 = await webSearch.execute('id-1', { query: 'test' })
      expect(r1.details.provider).toBe('duckduckgo')
      expect(calls.some(u => u.includes('duckduckgo.com'))).toBe(true)

      // User "saves" a new provider in Settings.
      currentProvider = 'tavily'

      const r2 = await webSearch.execute('id-2', { query: 'test' })
      expect(r2.details.provider).toBe('tavily')
      expect(calls.some(u => u.includes('api.tavily.com'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
