/**
 * Pure utility functions for parsing log entry data.
 *
 * Handles JSON strings (including truncated ones from the API),
 * parameter extraction, and input-data detection.
 */

/**
 * Safely parse a JSON string. Returns the raw string on failure.
 */
export function parseLogData(data: string | null | undefined): unknown {
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

/**
 * Check whether an input string contains meaningful data worth displaying.
 */
export function hasInputData(input: string | null | undefined): boolean {
  if (!input) return false
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object') return !!input
    return Object.keys(parsed).length > 0
  } catch {
    return !!input.trim()
  }
}

/**
 * Extract key-value preview pairs from a log entry's input JSON.
 * Handles truncated JSON gracefully via regex fallback.
 */
export function parseInputParams(input: string | null | undefined): Record<string, string> {
  if (!input) return {}
  try {
    const parsed = JSON.parse(input)
    return flattenParams(parsed)
  } catch {
    return extractParamsFromTruncated(input)
  }
}

/**
 * Flatten a parsed object into short string representations for badge display.
 */
function flattenParams(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.length === 0) return {}

  const result: Record<string, string> = {}
  for (const key of keys) {
    const val = (parsed as Record<string, unknown>)[key]
    const str = val === null ? 'null' : typeof val === 'object' ? JSON.stringify(val) : String(val)
    result[key] = str.length > 80 ? `${str.length} chars` : str
  }
  return result
}

/**
 * Best-effort key-value extraction from truncated JSON via regex.
 */
function extractParamsFromTruncated(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  const keyRegex = /"([^"]+)"\s*:\s*/g
  let match

  while ((match = keyRegex.exec(input)) !== null) {
    const key = match[1]!
    const afterColon = input.slice(match.index + match[0].length)

    if (afterColon.startsWith('"')) {
      const endQuote = findUnescapedQuote(afterColon, 1)
      if (endQuote === -1) {
        result[key] = 'truncated'
      } else {
        const val = afterColon.slice(1, endQuote)
        result[key] = val.length > 80 ? `${val.length} chars` : val
      }
    } else {
      const valMatch = afterColon.match(/^(true|false|null|-?\d+\.?\d*)/)
      if (valMatch?.[1]) {
        result[key] = valMatch[1]
      }
    }
  }
  return result
}

/**
 * Find the index of the next unescaped double-quote in a string.
 */
function findUnescapedQuote(str: string, start: number): number {
  for (let i = start; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue }
    if (str[i] === '"') return i
  }
  return -1
}
