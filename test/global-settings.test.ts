import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGlobalSettings, updateGlobalSettings } from '../src/global-settings.ts'
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
  it('accepts registered select metadata and rejects incomplete options', () => {
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
      settings: [{ key: 'outputStyle', kind: 'select', value: 'Default', effect: 'new-session', options: [{}] }],
    })).toBe(false)
  })
})
