import { describe, expect, it } from 'vitest'
import { formatTokenCount } from '../src/client/token-format.ts'

describe('compact token formatting', () => {
  it('formats task token counts deterministically', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(3_400)).toBe('3.4K')
    expect(formatTokenCount(131_400)).toBe('131K')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })
})
