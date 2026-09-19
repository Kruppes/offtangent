export function formatModelCost(value: number): string {
  if (value >= 0.01) return value.toFixed(2)
  return value.toFixed(3)
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10
    return `${millions}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}
