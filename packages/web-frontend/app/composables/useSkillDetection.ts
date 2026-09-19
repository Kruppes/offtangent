/**
 * Detects when a read_file tool call is loading a SKILL.md file
 * and provides helpers to extract skill name and formatted content.
 */
export function useSkillDetection() {

  /**
   * Check if a tool call is a skill load based on tool name and input data.
   * Works with both parsed objects and JSON strings.
   */
  function isSkillLoad(toolName: string, input: unknown): boolean {
    if (toolName !== 'read_file') return false
    const path = extractPath(input)
    return path !== null && /\/SKILL\.md$/i.test(path)
  }

  /**
   * Extract skill name from a tool call's input.
   * Returns the parent directory name of SKILL.md, e.g. "google-trends".
   */
  function getSkillName(input: unknown): string {
    const path = extractPath(input)
    if (!path) return 'unknown'
    const parts = path.replace(/\\/g, '/').split('/')
    const idx = parts.findIndex(p => /^SKILL\.md$/i.test(p))
    if (idx > 0) return parts[idx - 1] ?? 'unknown'
    return 'unknown'
  }

  /**
   * Extract the readable text content from a read_file output.
   * The output typically has the shape:
   *   { content: [{ type: "text", text: "..." }] }
   * or is a JSON string wrapping that structure.
   * Returns the text with real line breaks, or null if not extractable.
   */
  function extractSkillContent(output: unknown): string | null {
    const data = typeof output === 'string' ? safeParse(output) : output
    if (!data || typeof data !== 'object') return null

    // Handle { content: [{ type: "text", text: "..." }] }
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.content)) {
      const texts = (obj.content as Array<Record<string, unknown>>)
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text as string)
      if (texts.length > 0) {
        return texts.join('\n')
      }
    }

    // Handle plain string
    if (typeof obj.text === 'string') return obj.text

    return null
  }

  /** Extract path from input (handles JSON strings and objects) */
  function extractPath(input: unknown): string | null {
    if (!input) return null

    if (typeof input === 'string') {
      const parsed = safeParse(input)
      if (parsed && typeof parsed === 'object') {
        return ((parsed as Record<string, unknown>).path as string | undefined) ?? null
      }
      // Try regex for truncated JSON
      const match = input.match(/"path"\s*:\s*"([^"]*SKILL\.md[^"]*)"/)
      return match?.[1] ?? null
    }

    if (typeof input === 'object' && input !== null) {
      return ((input as Record<string, unknown>).path as string | undefined) ?? null
    }

    return null
  }

  function safeParse(str: string): unknown {
    try {
      return JSON.parse(str)
    } catch {
      return null
    }
  }

  return {
    isSkillLoad,
    getSkillName,
    extractSkillContent,
  }
}
