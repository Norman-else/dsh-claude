import { describe, expect, it } from 'vitest'
import { cachedExists, inlineCodeTokens, parseFileToken, sessionFileAddress } from '../src/client/file-mentions.ts'

describe('inline-code file mentions', () => {
  it('reads paths, with an optional line suffix, and leaves everything else as code', () => {
    expect(parseFileToken('/tmp/A_full.csv')).toEqual({ path: '/tmp/A_full.csv' })
    expect(parseFileToken('src/supervisor.ts:130')).toEqual({ path: 'src/supervisor.ts', line: 130 })
    expect(parseFileToken('README.md:24-30')).toEqual({ path: 'README.md', line: 24 })
    expect(parseFileToken('C:\\work\\out.xlsx')).toEqual({ path: 'C:\\work\\out.xlsx' })
    for (const value of ['pnpm check', 'master', 'https://x.io/a.md', 'src/**/*.ts', '--flag.x', '$HOME/a.txt', '~/a.txt', '']) {
      expect(parseFileToken(value)).toBeUndefined()
    }
  })

  it('collects each inline-code token once', () => {
    expect(inlineCodeTokens('see `a.ts` and `b/c` then `a.ts`')).toEqual(['a.ts', 'b/c'])
  })

  it('addresses a path through its Session the way the Host does', () => {
    expect(sessionFileAddress('s 1', './docs/a b.md')).toBe('dsh-resource://file/session/s%201/docs/a%20b.md')
    expect(sessionFileAddress('s', 'C:\\x\\y.txt')).toBe('dsh-resource://file/session/s/C:/x/y.txt')
  })

  it('asks the Host once per path and treats a failed stat as absent', async () => {
    const asked: string[] = []
    const exists = cachedExists(async path => {
      asked.push(path)
      if (path === 'boom') throw new Error('gateway')
      return path === 'yes'
    })
    expect(await exists('yes')).toBe(true)
    expect(await exists('yes')).toBe(true)
    expect(await exists('boom')).toBe(false)
    expect(asked).toEqual(['yes', 'boom'])
  })
})
