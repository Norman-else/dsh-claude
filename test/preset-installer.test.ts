import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-code-test-'))
  roots.push(root)
  const sourceDir = join(root, 'source')
  const targetDir = join(root, 'home', '.agent-presets', 'claude-code-cli')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, 'agent.cordis.yml'), '# managed\n- name: dsh-claude-code/preset-route\n')
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

  it('refuses to remove a modified preset', async () => {
    const paths = await fixture()
    await ensureManagedPreset(paths)
    await writeFile(join(paths.targetDir, 'agent.cordis.yml'), '# user edit\n')
    await expect(removeManagedPreset(paths)).rejects.toBeInstanceOf(ManagedPresetConflictError)
  })
})
