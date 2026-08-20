import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('client locale dictionaries', () => {
  it('keeps English and Chinese dictionaries balanced', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('localizes activity and diagnostic summaries', () => {
    expect(zh.thinking).toBe('思考')
    expect(zh.running).toBe('运行中')
    expect(zh.processSummary).toContain('{total}')
    expect(en.processSummary).toContain('{active}')
  })
})
