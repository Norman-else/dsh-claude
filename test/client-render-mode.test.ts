import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_RENDER_MODE_STORAGE_KEY,
  cacheClaudeRenderMode,
  claudeRenderMode,
  refreshClaudeRenderMode,
} from '../src/client/render-mode.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

function installStorage(storage: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}

const settingsResponse = (settings: unknown) => ({
  ok: true,
  json: async () => ({ settings }),
}) as Response

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
  vi.unstubAllGlobals()
})

describe('Claude client renderer selection', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('keeps the plugin transcript when no cache, no Web Storage, or a bad value is present', () => {
    expect(claudeRenderMode()).toBe('plugin')

    installStorage(fakeStorage())
    expect(claudeRenderMode()).toBe('plugin')

    installStorage(fakeStorage({ [CLAUDE_RENDER_MODE_STORAGE_KEY]: 'holographic' }))
    expect(claudeRenderMode()).toBe('plugin')

    // Private-mode browsers throw on access rather than returning null.
    installStorage({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(claudeRenderMode()).toBe('plugin')
    expect(() => cacheClaudeRenderMode('native')).not.toThrow()
  })

  it('reads back a cached choice and caches a new one', () => {
    const storage = fakeStorage()
    installStorage(storage)
    cacheClaudeRenderMode('native')
    expect(storage.values.get(CLAUDE_RENDER_MODE_STORAGE_KEY)).toBe('native')
    expect(claudeRenderMode()).toBe('native')
  })

  it('refreshes the boot cache from the settings route', async () => {
    const storage = fakeStorage()
    installStorage(storage)
    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse([
      { key: 'outputStyle', kind: 'select', value: 'Default' },
      { key: 'renderer', kind: 'select', value: 'native' },
    ])))

    await expect(refreshClaudeRenderMode()).resolves.toBe('native')
    expect(storage.values.get(CLAUDE_RENDER_MODE_STORAGE_KEY)).toBe('native')
  })

  it('leaves the previous choice in place when the Host cannot answer', async () => {
    const storage = fakeStorage({ [CLAUDE_RENDER_MODE_STORAGE_KEY]: 'native' })
    installStorage(storage)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(refreshClaudeRenderMode()).resolves.toBeUndefined()

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response))
    await expect(refreshClaudeRenderMode()).resolves.toBeUndefined()

    // An older Host answers without the descriptor at all.
    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse([{ key: 'outputStyle', kind: 'select', value: 'Default' }])))
    await expect(refreshClaudeRenderMode()).resolves.toBeUndefined()

    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse('nonsense')))
    await expect(refreshClaudeRenderMode()).resolves.toBeUndefined()

    expect(storage.values.get(CLAUDE_RENDER_MODE_STORAGE_KEY)).toBe('native')
  })
})
