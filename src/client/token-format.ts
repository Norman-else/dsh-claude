export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1))}K`
  return String(tokens)
}
