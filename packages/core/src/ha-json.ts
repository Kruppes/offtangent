/** JSON.parse alone silently accepts duplicate keys and overflowing numbers. */
export function parseHaJson(source: string): unknown {
  const value: unknown = JSON.parse(source)
  const frames: { object: boolean; key: boolean; names: Set<string> }[] = []
  // Syntax is already validated by JSON.parse; tokenize complete strings, never their contents.
  const tokens = new RegExp(String.raw`"(?:\\["\\/bfnrt]|\\u[\da-fA-F]{4}|[^"\\\x00-\x1f])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null`, 'g')
  for (const match of source.matchAll(tokens)) {
    const token = match[0], frame = frames.at(-1)
    if (token === '{' || token === '[') {
      if (frames.length >= 64) throw new SyntaxError('JSON nesting limit')
      frames.push({ object: token === '{', key: token === '{', names: new Set() })
    } else if (token === '}' || token === ']') frames.pop()
    else if (token === ',' && frame?.object) frame.key = true
    else if (token.startsWith('"') && frame?.object && frame.key) {
      const key: string = JSON.parse(token)
      if (frame.names.has(key)) throw new SyntaxError('Duplicate JSON key')
      frame.names.add(key); frame.key = false
    } else if (/^-?\d/.test(token) && !Number.isFinite(Number(token))) throw new SyntaxError('Non-finite JSON number')
  }
  return value
}
