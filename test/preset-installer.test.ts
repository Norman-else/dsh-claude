import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ManagedPresetConflictError,
  ensureManagedPreset,
  removeManagedPreset,
} from '../src/preset-installer.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-test-'))
  roots.push(root)
  const sourceDir = join(root, 'source')
  const targetDir = join(root, 'home', '.agent-presets', 'claude')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, 'agent.cordis.yml'), "# managed\n- name: '@norman-else/dsh-claude/preset-route'\n")
  await writeFile(join(sourceDir, 'preset.yml'), '# managed\nname: Claude Code CLI\n')
  return { sourceDir, targetDir }
}

describe('managed Agent Preset installation', () => {
  it('installs atomically and reruns idempotently', async () => {
    const paths = await fixture()
    await expect(ensureManagedPreset(paths)).resolves.toBe('installed')
    await expect(ensureManagedPreset(paths)).resolves.toBe('unchanged')
    await expect(readFile(join(paths.targetDir, 'preset.yml'), 'utf8')).resolves.toContain('Claude Code CLI')
  })

  it('converges under concurrent installers without replacing the winner', async () => {
    const paths = await fixture()
    await expect(Promise.all([
      ensureManagedPreset(paths),
      ensureManagedPreset(paths),
    ])).resolves.toHaveLength(2)
    await expect(readFile(join(paths.targetDir, 'preset.yml'), 'utf8')).resolves.toBe('# managed\nname: Claude Code CLI\n')
  })

  it('refuses to overwrite user-modified content', async () => {
    const paths = await fixture()
    await ensureManagedPreset(paths)
    await writeFile(join(paths.targetDir, 'preset.yml'), 'name: My Customized Claude\n')
    await expect(ensureManagedPreset(paths)).rejects.toBeInstanceOf(ManagedPresetConflictError)
  })

  it('removes only exact managed files', async () => {
    const paths = await fixture()
    await ensureManagedPreset(paths)
    await expect(removeManagedPreset(paths)).resolves.toBe('removed')
    await expect(removeManagedPreset(paths)).resolves.toBe('absent')
  })

  it('refuses to remove a modified preset without partially deleting it', async () => {
    const paths = await fixture()
    await ensureManagedPreset(paths)
    await writeFile(join(paths.targetDir, 'preset.yml'), 'name: My Customized Claude\n')
    const managedAgent = await readFile(join(paths.targetDir, 'agent.cordis.yml'), 'utf8')

    await expect(removeManagedPreset(paths)).rejects.toBeInstanceOf(ManagedPresetConflictError)
    await expect(readFile(join(paths.targetDir, 'agent.cordis.yml'), 'utf8')).resolves.toBe(managedAgent)
    await expect(readFile(join(paths.targetDir, 'preset.yml'), 'utf8')).resolves.toBe('name: My Customized Claude\n')
  })

  it('keeps the route on the active profile package source', async () => {
    const paths = await fixture()
    await expect(ensureManagedPreset(paths)).resolves.toBe('installed')
    const installed = await readFile(join(paths.targetDir, 'agent.cordis.yml'), 'utf8')
    expect(installed).toContain("name: '@norman-else/dsh-claude/preset-route'")
    expect(installed).not.toContain('lib/preset-route.mjs')
  })

  it('upgrades legacy bare-specifier content left by older installers', async () => {
    const paths = await fixture()
    const legacy = '# managed\n- id: claude-code-route\n  name: @norman-else/dsh-claude/preset-route\n'
    await mkdir(paths.targetDir, { recursive: true })
    await writeFile(join(paths.targetDir, 'agent.cordis.yml'), legacy)
    await writeFile(join(paths.targetDir, 'preset.yml'), '# managed\nname: Claude Code CLI\n')
    await expect(ensureManagedPreset(paths)).resolves.toBe('installed')
    const upgraded = await readFile(join(paths.targetDir, 'agent.cordis.yml'), 'utf8')
    expect(upgraded).toContain("name: '@norman-else/dsh-claude/preset-route'")
    expect(upgraded).not.toContain('lib/preset-route.mjs')
    await expect(ensureManagedPreset(paths)).resolves.toBe('unchanged')
  })

  it('upgrades legacy content even when template comments drifted', async () => {
    const paths = await fixture()
    await mkdir(paths.targetDir, { recursive: true })
    await writeFile(join(paths.targetDir, 'agent.cordis.yml'), '# older installer generation\n- id: claude-code-route\n  name: @norman-else/dsh-claude/preset-route\n')
    await writeFile(join(paths.targetDir, 'preset.yml'), '# managed\nname: Claude Code CLI\n')
    await expect(ensureManagedPreset(paths)).resolves.toBe('installed')
    const upgraded = await readFile(join(paths.targetDir, 'agent.cordis.yml'), 'utf8')
    expect(upgraded).not.toContain('name: @norman-else/dsh-claude/preset-route')
    await expect(ensureManagedPreset(paths)).resolves.toBe('unchanged')
  })

  it('removes legacy bare-specifier content without a conflict', async () => {
    const paths = await fixture()
    const legacy = await readFile(join(paths.sourceDir, 'agent.cordis.yml'), 'utf8')
    await mkdir(paths.targetDir, { recursive: true })
    await writeFile(join(paths.targetDir, 'agent.cordis.yml'), legacy)
    await writeFile(join(paths.targetDir, 'preset.yml'), '# managed\nname: Claude Code CLI\n')
    await expect(removeManagedPreset(paths)).resolves.toBe('removed')
    await expect(readdir(paths.targetDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a symlinked target directory', async () => {
    const paths = await fixture()
    const realDir = join(paths.targetDir, '..', 'real-preset-dir')
    await mkdir(realDir, { recursive: true })
    const symlinkTarget = paths.targetDir
    const symlinkSource = join(paths.targetDir, '..', 'claude-link')
    await symlink(realDir, symlinkSource)
    await expect(ensureManagedPreset({ ...paths, targetDir: symlinkSource })).rejects.toBeInstanceOf(ManagedPresetConflictError)
    // And the real dir must not have been written through the link.
    await expect(readdir(realDir)).resolves.toEqual([])
  })
})
