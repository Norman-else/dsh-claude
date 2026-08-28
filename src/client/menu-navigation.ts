/** Wrapping keyboard navigation shared by the plugin's popup lists. */
export function menuNavigationIndex(current: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return 0
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const step = key === 'ArrowDown' ? 1 : -1
  return (current + step + count) % count
}
