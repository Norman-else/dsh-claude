import { describe, expect, it, vi } from 'vitest'
import { ManagedPresetConflictError } from '../src/preset-installer.ts'
import { installManagedPresetCompatibility } from '../src/index.ts'

describe('managed preset activation compatibility', () => {
  it('installs the managed preset during Host activation', async () => {
    const warn = vi.fn()
    const install = vi.fn(async () => 'installed' as const)

    await expect(installManagedPresetCompatibility({ warn }, install)).resolves.toBe('installed')
    expect(install).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
  })

  it('preserves a user-modified preset and logs a warning', async () => {
    const warn = vi.fn()
    const install = vi.fn(async () => {
      throw new ManagedPresetConflictError('C:\\Users\\test\\.dsh\\.agent-presets\\claude\\preset.yml')
    })

    await expect(installManagedPresetCompatibility({ warn }, install)).resolves.toBe('conflict')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preserving user-modified preset'))
  })

  it('fails activation for unexpected installation errors', async () => {
    const error = new Error('disk unavailable')
    const install = vi.fn(async () => { throw error })

    await expect(installManagedPresetCompatibility({ warn: vi.fn() }, install)).rejects.toBe(error)
  })
})
