import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { encrypt, decrypt, isEncrypted } from './encryption.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SearchProvider = 'duckduckgo' | 'brave' | 'searxng' | 'tavily'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchConfig {
  provider?: SearchProvider
  braveSearchApiKey?: string
  searxngUrl?: string
  tavilyApiKey?: string
  retry?: {
    maxRetries?: number
    baseDelayMs?: number
    delayFn?: (ms: number) => Promise<void>
  }
}

// Currently no provider-specific config needed, but reserved for future options.
export type WebFetchConfig = Record<string, never>

export interface BuiltinToolsConfig {
  webSearch?: {
    enabled?: boolean
    provider?: string
    braveSearchApiKey?: string
    searxngUrl?: string
    tavilyApiKey?: string
  }
  webFetch?: { enabled?: boolean }
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export type BraveErrorCategory = 'auth' | 'rate_limit' | 'server_error' | 'network' | 'unknown'

export class BraveSearchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly category: BraveErrorCategory,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'BraveSearchError'
  }
}

export type TavilyErrorCategory = 'auth' | 'rate_limit' | 'server_error' | 'network' | 'unknown'

export class TavilySearchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly category: TavilyErrorCategory,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'TavilySearchError'
  }
}

// ─── HTML-to-Text Extraction ─────────────────────────────────────────────────

/**
 * Extract readable text from HTML by stripping tags, scripts, styles,
 * and normalizing whitespace. Simple, zero-dependency approach.
 */
export function extractTextFromHtml(html: string): string {
  let text = html

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  // Replace common block elements with newlines
  text = text.replace(/<\/?(?:div|p|br|hr|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main|aside|figure|figcaption|details|summary)\b[^>]*>/gi, '\n')

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, ' ')
  text = text.replace(/&amp;/gi, '&')
  text = text.replace(/&lt;/gi, '<')
  text = text.replace(/&gt;/gi, '>')
  text = text.replace(/&quot;/gi, '"')
  text = text.replace(/&#39;/gi, "'")
  text = text.replace(/&#x27;/gi, "'")
  text = text.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))

  // Normalize whitespace: collapse multiple spaces/tabs on same line
  text = text.replace(/[ \t]+/g, ' ')

  // Collapse 3+ consecutive newlines into 2
  text = text.replace(/\n{3,}/g, '\n\n')

  // Trim each line
  text = text.split('\n').map(line => line.trim()).join('\n')

  return text.trim()
}

// ─── Inline HTML Stripping ───────────────────────────────────────────────────

/**
 * Strip inline HTML tags and decode common entities.
 * Lighter than extractTextFromHtml — designed for short snippets.
 */
export function stripInlineHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Retry Utility ───────────────────────────────────────────────────────────

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  shouldRetry?: (err: unknown) => boolean
  delayFn?: (ms: number) => Promise<void>
}

const defaultDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Execute a function with retry and exponential backoff.
 * Returns the result along with the number of retries that occurred.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<{ result: T; retries: number }> {
  const { maxRetries, baseDelayMs, shouldRetry, delayFn = defaultDelay } = opts
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()
      return { result, retries: attempt }
    } catch (err) {
      lastError = err
      if (attempt < maxRetries && (!shouldRetry || shouldRetry(err))) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        await delayFn(delay)
      } else {
        break
      }
    }
  }

  throw lastError
}

// ─── DuckDuckGo Search Provider ──────────────────────────────────────────────

/**
 * Search DuckDuckGo using the HTML lite interface.
 * Parses results from the lite HTML page (no API key needed).
 */
export async function searchDuckDuckGo(
  query: string,
  count: number = 5,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WebSearchResult[]> {
  const url = 'https://lite.duckduckgo.com/lite/'
  const body = new URLSearchParams({ q: query })

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; Axiom/1.0)',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`)
  }

  const html = await response.text()
  return parseDuckDuckGoLiteHtml(html, count)
}

/**
 * Parse DuckDuckGo Lite HTML results page.
 *
 * The lite page has a table-based layout where results appear as:
 * - A link in a <a rel="nofollow" ...> tag (title + URL)
 * - A snippet in a subsequent <td> with class "result-snippet"
 */
export function parseDuckDuckGoLiteHtml(html: string, count: number): WebSearchResult[] {
  const results: WebSearchResult[] = []

  // Match result links: <a rel="nofollow" href="..." class="result-link">Title</a>
  // Note: DuckDuckGo Lite uses single quotes for class attributes on organic results
  const linkPattern = /<a[^>]+rel="nofollow"[^>]+href="([^"]*)"[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi
  // Also try alternative pattern where class comes before rel
  const linkPattern2 = /<a[^>]+class=["']result-link["'][^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi

  const snippetPattern = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi

  // Collect all links
  const links: { url: string; title: string }[] = []
  for (const pattern of [linkPattern, linkPattern2]) {
    let match
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1].replace(/&amp;/g, '&')
      const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
      // Avoid duplicates
      if (title && url && !links.some(l => l.url === url)) {
        links.push({ url, title })
      }
    }
  }

  // Collect all snippets
  const snippets: string[] = []
  let snippetMatch
  while ((snippetMatch = snippetPattern.exec(html)) !== null) {
    const snippet = snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
    snippets.push(snippet)
  }

  // Combine links with snippets
  for (let i = 0; i < Math.min(links.length, count); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? '',
    })
  }

  return results
}

// ─── Brave Search Provider ───────────────────────────────────────────────────

/**
 * Search using Brave Search API v1.
 * Requires an API key sent via X-Subscription-Token header.
 */
export async function searchBrave(
  query: string,
  apiKey: string,
  count: number = 5,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WebSearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  })

  if (!response.ok) {
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch { /* ignore body read failures */ }

    const detail = bodyText ? ` Details: ${bodyText}` : ''
    const status = response.status

    if (status === 401) {
      throw new BraveSearchError(
        `Brave Search auth failed (HTTP 401): invalid or missing API key. Check your braveSearchApiKey configuration.${detail}`,
        status, 'auth', false,
      )
    }

    if (status === 429) {
      throw new BraveSearchError(
        `Brave Search rate limited (HTTP 429). You may have hit the free plan limit.${detail}`,
        status, 'rate_limit', true,
      )
    }

    if (status >= 500) {
      throw new BraveSearchError(
        `Brave Search server error (HTTP ${status}).${detail}`,
        status, 'server_error', true,
      )
    }

    throw new BraveSearchError(
      `Brave Search failed (HTTP ${status}).${detail}`,
      status, 'unknown', false,
    )
  }

  const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
  const webResults = data?.web?.results ?? []

  return webResults.slice(0, count).map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: stripInlineHtml(r.description ?? ''),
  }))
}

// ─── Tavily Search Provider ──────────────────────────────────────────────────

/**
 * Search using the Tavily Search API.
 * Tavily is a search API built specifically for AI agents — it returns clean,
 * structured results in a single call.
 *
 * API: POST https://api.tavily.com/search
 * Auth: Authorization: Bearer <key>
 * Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
export async function searchTavily(
  query: string,
  apiKey: string,
  count: number = 5,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WebSearchResult[]> {
  const response = await fetchFn('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: count,
      search_depth: 'basic',
    }),
  })

  if (!response.ok) {
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch { /* ignore body read failures */ }

    const detail = bodyText ? ` Details: ${bodyText}` : ''
    const status = response.status

    if (status === 401) {
      throw new TavilySearchError(
        `Tavily Search auth failed (HTTP 401): invalid or missing API key. Check your tavilyApiKey configuration.${detail}`,
        status, 'auth', false,
      )
    }

    if (status === 429) {
      throw new TavilySearchError(
        `Tavily Search rate limited (HTTP 429). You may have hit the free plan monthly quota.${detail}`,
        status, 'rate_limit', true,
      )
    }

    if (status >= 500) {
      throw new TavilySearchError(
        `Tavily Search server error (HTTP ${status}).${detail}`,
        status, 'server_error', true,
      )
    }

    throw new TavilySearchError(
      `Tavily Search failed (HTTP ${status}).${detail}`,
      status, 'unknown', false,
    )
  }

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  const results = data?.results ?? []

  return results.slice(0, count).map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }))
}

// ─── SearXNG Search Provider ─────────────────────────────────────────────────

/**
 * Search using a SearXNG instance JSON API.
 * Requires the base URL of the SearXNG instance.
 */
export async function searchSearXNG(
  query: string,
  searxngUrl: string,
  count: number = 5,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WebSearchResult[]> {
  // Normalize URL: remove trailing slash
  const baseUrl = searxngUrl.replace(/\/+$/, '')
  const url = new URL(`${baseUrl}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; Axiom/1.0)',
    },
  })

  if (!response.ok) {
    throw new Error(`SearXNG search failed: HTTP ${response.status}`)
  }

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  const results = data?.results ?? []

  return results.slice(0, count).map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }))
}

// ─── Provider Selection ──────────────────────────────────────────────────────

/**
 * Encrypt a Brave Search API key for storage in settings.json.
 */
export function encryptBraveApiKey(apiKey: string): string {
  if (!apiKey) return ''
  return isEncrypted(apiKey) ? apiKey : encrypt(apiKey)
}

/**
 * Decrypt a Brave Search API key from settings.json.
 */
export function decryptBraveApiKey(encryptedKey: string): string {
  return decrypt(encryptedKey)
}

/**
 * Encrypt a Tavily API key for storage in settings.json.
 */
export function encryptTavilyApiKey(apiKey: string): string {
  if (!apiKey) return ''
  return isEncrypted(apiKey) ? apiKey : encrypt(apiKey)
}

/**
 * Decrypt a Tavily API key from settings.json.
 */
export function decryptTavilyApiKey(encryptedKey: string): string {
  return decrypt(encryptedKey)
}

export interface ResolvedSearchProvider {
  provider: SearchProvider
  searchFn: (query: string, count: number) => Promise<WebSearchResult[]>
  warning?: string
}

/**
 * Resolve the search provider based on config.
 * Falls back to DuckDuckGo with a warning if the selected provider is misconfigured.
 */
export function resolveSearchProvider(config?: WebSearchConfig): ResolvedSearchProvider {
  const requested = config?.provider ?? 'duckduckgo'

  if (requested === 'brave') {
    const rawKey = config?.braveSearchApiKey ?? ''
    if (!rawKey) {
      return {
        provider: 'duckduckgo',
        searchFn: (query, count) => searchDuckDuckGo(query, count),
        warning: 'Brave Search selected but no API key configured. Falling back to DuckDuckGo.',
      }
    }
    // Decrypt key if it looks encrypted
    const apiKey = isEncrypted(rawKey) ? decryptBraveApiKey(rawKey) : rawKey
    return {
      provider: 'brave',
      searchFn: (query, count) => searchBrave(query, apiKey, count),
    }
  }

  if (requested === 'searxng') {
    const searxngUrl = config?.searxngUrl ?? ''
    if (!searxngUrl) {
      return {
        provider: 'duckduckgo',
        searchFn: (query, count) => searchDuckDuckGo(query, count),
        warning: 'SearXNG selected but no instance URL configured. Falling back to DuckDuckGo.',
      }
    }
    return {
      provider: 'searxng',
      searchFn: (query, count) => searchSearXNG(query, searxngUrl, count),
    }
  }

  if (requested === 'tavily') {
    const rawKey = config?.tavilyApiKey ?? ''
    if (!rawKey) {
      return {
        provider: 'duckduckgo',
        searchFn: (query, count) => searchDuckDuckGo(query, count),
        warning: 'Tavily Search selected but no API key configured. Falling back to DuckDuckGo.',
      }
    }
    // Decrypt key if it looks encrypted
    const apiKey = isEncrypted(rawKey) ? decryptTavilyApiKey(rawKey) : rawKey
    return {
      provider: 'tavily',
      searchFn: (query, count) => searchTavily(query, apiKey, count),
    }
  }

  // Default: DuckDuckGo
  return {
    provider: 'duckduckgo',
    searchFn: (query, count) => searchDuckDuckGo(query, count),
  }
}

// ─── Tool Factories ──────────────────────────────────────────────────────────

/**
 * Either a static `WebSearchConfig` or a getter that returns the current
 * config on each invocation. The getter form lets callers wire the tool to a
 * live settings source so that provider/API-key changes from Settings → Built-in
 * Tools take effect on the next `web_search` call without requiring a server
 * restart.
 */
export type WebSearchConfigSource = WebSearchConfig | (() => WebSearchConfig | undefined)

function resolveWebSearchConfig(source?: WebSearchConfigSource): WebSearchConfig | undefined {
  return typeof source === 'function' ? source() : source
}

/**
 * Create the web_search AgentTool.
 * Supports DuckDuckGo, Brave Search, SearXNG, and Tavily providers.
 */
export function createWebSearchTool(config?: WebSearchConfigSource): AgentTool {
  const isDynamic = typeof config === 'function'

  const staticConfig = isDynamic ? undefined : config
  const staticResolved = isDynamic ? null : resolveSearchProvider(staticConfig)
  if (staticResolved?.warning) {
    console.warn(`[web_search] ${staticResolved.warning}`)
  }

  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for information. Returns a list of results with title, URL, and snippet. ' +
      'Use this to find current information, documentation, facts, or candidate sources. Search results are not the source itself — fetch the most relevant page before making claims about its contents.',
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      count: Type.Optional(Type.Number({ description: 'Number of results to return (default: 5, max: 20)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { query, count: rawCount } = params as { query: string; count?: number }
      const count = Math.min(Math.max(rawCount ?? 5, 1), 20)

      const currentConfig = isDynamic ? resolveWebSearchConfig(config) : staticConfig
      const resolved = isDynamic ? resolveSearchProvider(currentConfig) : staticResolved!
      if (isDynamic && resolved.warning) {
        console.warn(`[web_search] ${resolved.warning}`)
      }

      const retryOpts: RetryOptions = {
        maxRetries: resolved.provider !== 'duckduckgo' ? (currentConfig?.retry?.maxRetries ?? 2) : 0,
        baseDelayMs: currentConfig?.retry?.baseDelayMs ?? 500,
        shouldRetry: (err: unknown) =>
          (err instanceof BraveSearchError && err.retryable) ||
          (err instanceof TavilySearchError && err.retryable),
        delayFn: currentConfig?.retry?.delayFn,
      }

      let results: WebSearchResult[]
      let retries = 0
      let usedFallback = false
      let failureCategory: BraveErrorCategory | TavilyErrorCategory | 'network' | undefined

      try {
        const retryResult = await withRetry(
          () => resolved.searchFn(query, count),
          retryOpts,
        )
        results = retryResult.result
        retries = retryResult.retries
      } catch (err: unknown) {
        failureCategory =
          err instanceof BraveSearchError ? err.category :
          err instanceof TavilySearchError ? err.category :
          'network'

        // Fall back to DuckDuckGo if primary provider is not already DDG
        if (resolved.provider !== 'duckduckgo') {
          try {
            results = await searchDuckDuckGo(query, count)
            usedFallback = true
          } catch (_fallbackErr: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `Search failed: ${message}` }],
              details: { error: true, query, provider: resolved.provider, failureCategory },
            }
          }
        } else {
          const message = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: 'text' as const, text: `Search failed: ${message}` }],
            details: { error: true, query, provider: resolved.provider },
          }
        }
      }

      const actualProvider = usedFallback ? 'duckduckgo' : resolved.provider

      if (results!.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No results found for: "${query}"` }],
          details: {
            query,
            count: 0,
            provider: actualProvider,
            ...(retries > 0 && { retries }),
            ...(usedFallback && { fallback: true, requestedProvider: resolved.provider, failureCategory }),
          },
        }
      }

      const formatted = results!
        .map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`)
        .join('\n\n')

      const fallbackNote = usedFallback
        ? `\n\n_Note: ${resolved.provider} search failed after retries. Results from DuckDuckGo fallback._`
        : ''

      return {
        content: [{ type: 'text' as const, text: formatted + fallbackNote }],
        details: {
          query,
          count: results!.length,
          provider: actualProvider,
          results: results!,
          ...(retries > 0 && { retries }),
          ...(usedFallback && { fallback: true, requestedProvider: resolved.provider, failureCategory }),
        },
      }
    },
  }
}

/**
 * Create the web_fetch AgentTool.
 * Fetches a URL and extracts readable text content.
 */
export function createWebFetchTool(_config?: WebFetchConfig): AgentTool {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch a web page and extract its text content. Use this to read articles, documentation, ' +
      'blog posts, or other web pages when you need the page contents themselves rather than a search result. Returns extracted text without HTML tags. Use this after web_search when you need to verify what a page actually says.',
    parameters: Type.Object({
      url: Type.String({ description: 'The URL to fetch. Provide a complete URL including the scheme, e.g. https://example.com/page' }),
      maxLength: Type.Optional(Type.Number({ description: 'Maximum length of extracted text to return (default: 50000). Lower this when you only need a focused excerpt.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { url, maxLength: rawMaxLength } = params as { url: string; maxLength?: number }
      const maxLength = rawMaxLength ?? 50000

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Axiom/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(30000),
        })

        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Failed to fetch URL: HTTP ${response.status} ${response.statusText}` }],
            details: { error: true, url, status: response.status },
          }
        }

        const contentType = response.headers.get('content-type') ?? ''
        const body = await response.text()

        let text: string
        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
          text = extractTextFromHtml(body)
        } else {
          // Plain text, JSON, etc. — return as-is
          text = body
        }

        const truncated = text.length > maxLength
        if (truncated) {
          text = text.slice(0, maxLength) + '\n\n[Content truncated at ' + maxLength + ' characters]'
        }

        return {
          content: [{ type: 'text' as const, text }],
          details: { url, length: text.length, truncated, contentType },
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Failed to fetch URL: ${message}` }],
          details: { error: true, url },
        }
      }
    },
  }
}

// ─── Builtin Tools Factory ───────────────────────────────────────────────────

/**
 * Either a static `BuiltinToolsConfig` or a getter that returns the current
 * config on each invocation. When a getter is supplied, `web_search` resolves
 * its provider/API-keys fresh on every call — enabling hot-reload of
 * Settings > Built-in Tools without a server restart.
 */
export type BuiltinToolsConfigSource = BuiltinToolsConfig | (() => BuiltinToolsConfig | undefined)

function resolveBuiltinToolsConfig(source?: BuiltinToolsConfigSource): BuiltinToolsConfig | undefined {
  return typeof source === 'function' ? source() : source
}

/**
 * Create all enabled built-in web tools based on config.
 * This is the main entry point for AgentCore integration.
 */
export function createBuiltinWebTools(config?: BuiltinToolsConfigSource): AgentTool[] {
  const isDynamic = typeof config === 'function'
  const initialConfig = resolveBuiltinToolsConfig(config)

  const tools: AgentTool[] = []

  // web_search — enabled by default
  if (initialConfig?.webSearch?.enabled !== false) {
    if (isDynamic) {
      const getter = (): WebSearchConfig | undefined => {
        const current = resolveBuiltinToolsConfig(config)
        const provider = (current?.webSearch?.provider ?? 'duckduckgo') as SearchProvider
        return {
          provider,
          braveSearchApiKey: current?.webSearch?.braveSearchApiKey,
          searxngUrl: current?.webSearch?.searxngUrl,
          tavilyApiKey: current?.webSearch?.tavilyApiKey,
        }
      }
      tools.push(createWebSearchTool(getter))
    } else {
      const provider = (initialConfig?.webSearch?.provider ?? 'duckduckgo') as SearchProvider
      tools.push(createWebSearchTool({
        provider,
        braveSearchApiKey: initialConfig?.webSearch?.braveSearchApiKey,
        searxngUrl: initialConfig?.webSearch?.searxngUrl,
        tavilyApiKey: initialConfig?.webSearch?.tavilyApiKey,
      }))
    }
  }

  // web_fetch — enabled by default
  if (initialConfig?.webFetch?.enabled !== false) {
    tools.push(createWebFetchTool())
  }

  return tools
}
