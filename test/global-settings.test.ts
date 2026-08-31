import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGlobalSettings, readRenderMode, readSupervisorLimitOverrides, updateGlobalSettings } from '../src/global-settings.ts'
import { isGlobalSettingsView } from '../src/client/ClaudeCodeSettings.tsx'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-global-settings-'))
  roots.push(root)
  return {
    root,
    settingsFile: join(root, '.claude', 'settings.json'),
    outputStylesDir: join(root, '.claude', 'output-styles'),
    pluginSettingsFile: join(root, 'dsh', 'settings.json'),
  }
}

describe('Claude Code global settings registry', () => {
  it('returns built-in and bounded custom output-style names without prompt bodies', async () => {
    const paths = await fixture()
    await mkdir(paths.outputStylesDir, { recursive: true })
    await writeFile(join(paths.outputStylesDir, 'review.md'), [
      '---',
      'name: Code Reviewer',
      'description: Private description',
      '---',
      'SECRET STYLE PROMPT BODY',
    ].join('\n'))
    await writeFile(join(paths.outputStylesDir, 'fallback.md'), 'No frontmatter\nSECRET FALLBACK BODY')

    const result = await readGlobalSettings({ paths })
    const outputStyle = result.settings.find(setting => setting.key === 'outputStyle')!
    expect(outputStyle).toMatchObject({ value: 'Default', effect: 'new-session' })
    expect(outputStyle.options.map(option => option.value)).toEqual(expect.arrayContaining([
      'Default', 'Proactive', 'Concise', 'Explanatory', 'Learning', 'Code Reviewer', 'fallback',
    ]))
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('Private description')
  })

  it('stores the Worktree branch prefix in plugin settings with a claude default', async () => {
    const paths = await fixture()
    const initial = await readGlobalSettings({ paths })
    expect(initial.settings.find(setting => setting.key === 'worktreeBranchPrefix')).toMatchObject({
      kind: 'text', value: 'claude', effect: 'next-worktree', maxLength: 128,
    })

    const updated = await updateGlobalSettings({ worktreeBranchPrefix: 'team/claude' }, { paths })
    expect(updated.settings.find(setting => setting.key === 'worktreeBranchPrefix')).toMatchObject({ value: 'team/claude' })
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({ worktreeBranchPrefix: 'team/claude' })
    await expect(readFile(paths.settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(updateGlobalSettings({ worktreeBranchPrefix: '../invalid' }, { paths })).rejects.toThrow('Invalid value')
  })

  it('stores the prose highlight mode in plugin settings, defaulting to plain', async () => {
    const paths = await fixture()
    const initial = await readGlobalSettings({ paths })
    expect(initial.settings.find(setting => setting.key === 'prose')).toMatchObject({
      kind: 'select', value: 'plain', effect: 'immediate',
    })
    expect(initial.settings.find(setting => setting.key === 'prose')?.options).toEqual([
      { value: 'plain', label: 'plain', source: 'built-in' },
      { value: 'enhanced', label: 'enhanced', source: 'built-in' },
    ])

    const updated = await updateGlobalSettings({ prose: 'enhanced' }, { paths })
    expect(updated.settings.find(setting => setting.key === 'prose')).toMatchObject({ value: 'enhanced' })
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({ prose: 'enhanced' })

    // Back to the default: the key is deleted rather than written, so a
    // never-touched setting leaves no trace in the document.
    await updateGlobalSettings({ prose: 'plain' }, { paths })
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({})
    await expect(updateGlobalSettings({ prose: 'neon' }, { paths })).rejects.toThrow('Invalid value')
  })

  it('stores the AI output renderer in plugin settings, defaulting to the plugin transcript', async () => {
    const paths = await fixture()
    const initial = await readGlobalSettings({ paths })
    expect(initial.settings.find(setting => setting.key === 'renderer')).toMatchObject({
      kind: 'select', value: 'plugin', effect: 'next-turn',
    })
    expect(initial.settings.find(setting => setting.key === 'renderer')?.options).toEqual([
      { value: 'plugin', label: 'plugin', source: 'built-in' },
      { value: 'native', label: 'native', source: 'built-in' },
    ])
    await expect(readRenderMode({ paths })).resolves.toBe('plugin')

    const updated = await updateGlobalSettings({ renderer: 'native' }, { paths })
    expect(updated.settings.find(setting => setting.key === 'renderer')).toMatchObject({ value: 'native' })
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({ renderer: 'native' })
    // The renderer is a plugin concern; Claude Code's own settings stay untouched.
    await expect(readFile(paths.settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readRenderMode({ paths })).resolves.toBe('native')

    // Choosing the default clears the key rather than pinning today's default.
    await updateGlobalSettings({ renderer: 'plugin' }, { paths })
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({})
    await expect(updateGlobalSettings({ renderer: 'Native' }, { paths })).rejects.toThrow('Invalid value')
  })

  it('falls back to the plugin transcript for a malformed or absent renderer value', async () => {
    const paths = await fixture()
    await mkdir(join(paths.root, 'dsh'), { recursive: true })
    await writeFile(paths.pluginSettingsFile, JSON.stringify({ renderer: 'holographic' }))
    expect((await readGlobalSettings({ paths })).settings.find(setting => setting.key === 'renderer')).toMatchObject({ value: 'plugin' })
    await expect(readRenderMode({ paths })).resolves.toBe('plugin')

    await writeFile(paths.pluginSettingsFile, 'not json')
    await expect(readRenderMode({ paths })).resolves.toBe('plugin')
  })

  it('exposes supervisor limits as bounded integers seeded from the plugin config', async () => {
    const paths = await fixture()
    const deps = { paths, defaultLimits: { maxProcesses: 6, idleTimeoutMs: 45 * 60_000 } }
    const initial = await readGlobalSettings(deps)
    expect(initial.settings.find(setting => setting.key === 'maxProcesses')).toMatchObject({
      kind: 'text', value: '6', effect: 'new-session', maxLength: 2,
    })
    expect(initial.settings.find(setting => setting.key === 'idleTimeoutMinutes')).toMatchObject({
      kind: 'text', value: '45', effect: 'new-session', maxLength: 4,
    })
    await expect(readSupervisorLimitOverrides(deps)).resolves.toEqual({})

    const updated = await updateGlobalSettings({ maxProcesses: '8', idleTimeoutMinutes: '10' }, deps)
    expect(updated.settings.find(setting => setting.key === 'maxProcesses')).toMatchObject({ value: '8' })
    expect(updated.settings.find(setting => setting.key === 'idleTimeoutMinutes')).toMatchObject({ value: '10' })
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({ maxProcesses: 8, idleTimeoutMinutes: 10 })
    await expect(readSupervisorLimitOverrides(deps)).resolves.toEqual({ maxProcesses: 8, idleTimeoutMs: 600_000 })

    await expect(updateGlobalSettings({ maxProcesses: '0' }, deps)).rejects.toThrow('Invalid value')
    await expect(updateGlobalSettings({ maxProcesses: '17' }, deps)).rejects.toThrow('Invalid value')
    await expect(updateGlobalSettings({ idleTimeoutMinutes: '2.5' }, deps)).rejects.toThrow('Invalid value')
    await expect(updateGlobalSettings({ idleTimeoutMinutes: '' }, deps)).rejects.toThrow('Invalid value')
  })

  it('updates only outputStyle, preserves unknown settings, and writes user-only permissions', async () => {
    const paths = await fixture()
    await mkdir(join(paths.root, '.claude'), { recursive: true })
    await writeFile(paths.settingsFile, JSON.stringify({ permissions: { allow: ['Read'] }, theme: 'dark' }))

    const result = await updateGlobalSettings({ outputStyle: 'Explanatory' }, { paths })
    expect(result.settings[0]).toMatchObject({ key: 'outputStyle', value: 'Explanatory' })
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual({
      permissions: { allow: ['Read'] },
      theme: 'dark',
      outputStyle: 'Explanatory',
    })
    if (process.platform !== 'win32') expect((await stat(paths.settingsFile)).mode & 0o777).toBe(0o600)
  })

  it('preserves an existing undiscovered style in the public options', async () => {
    const paths = await fixture()
    await mkdir(join(paths.root, '.claude'), { recursive: true })
    await writeFile(paths.settingsFile, JSON.stringify({ outputStyle: 'Managed Reviewer' }))
    const result = await readGlobalSettings({ paths })
    expect(result.settings[0]).toMatchObject({ value: 'Managed Reviewer' })
    expect(result.settings[0]?.options).toContainEqual({ value: 'Managed Reviewer', label: 'Managed Reviewer', source: 'configured' })
  })

  it('removes the override for Default and rejects unknown fields or unavailable styles', async () => {
    const paths = await fixture()
    await mkdir(join(paths.root, '.claude'), { recursive: true })
    await writeFile(paths.settingsFile, JSON.stringify({ outputStyle: 'Learning', keep: true }))

    await updateGlobalSettings({ outputStyle: 'Default' }, { paths })
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual({ keep: true })
    await expect(updateGlobalSettings({ arbitrary: true }, { paths })).rejects.toThrow('Unsupported global setting')
    await expect(updateGlobalSettings({ outputStyle: 'Missing private style' }, { paths })).rejects.toThrow('Invalid value')
  })

  it('serializes concurrent changes without producing malformed settings', async () => {
    const paths = await fixture()
    await Promise.all([
      updateGlobalSettings({ outputStyle: 'Proactive' }, { paths }),
      updateGlobalSettings({ outputStyle: 'Learning' }, { paths }),
    ])
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual({ outputStyle: 'Learning' })
  })
})

describe('global settings client response validation', () => {
  it('accepts registered select and text metadata and rejects incomplete options', () => {
    expect(isGlobalSettingsView({
      settings: [{
        key: 'outputStyle',
        kind: 'select',
        value: 'Default',
        effect: 'new-session',
        options: [{ value: 'Default', label: 'Default', source: 'built-in' }],
      }],
    })).toBe(true)
    expect(isGlobalSettingsView({
      settings: [{ key: 'worktreeBranchPrefix', kind: 'text', value: 'claude', effect: 'next-worktree', maxLength: 128 }],
    })).toBe(true)
    expect(isGlobalSettingsView({
      settings: [{ key: 'outputStyle', kind: 'select', value: 'Default', effect: 'new-session', options: [{}] }],
    })).toBe(false)
  })
})
