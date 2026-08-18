import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CLAUDE_CODE_PRESET_ID } from './constants.ts'

export const MANAGED_PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

export class ManagedPresetConflictError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`dsh-claude-code: refusing to overwrite user-modified preset file ${path}`)
    this.name = 'ManagedPresetConflictError'
    this.path = path
  }
}

export interface ManagedPresetPaths {
  sourceDir: string
  targetDir: string
}

export function defaultManagedPresetPaths(dshHome?: string): ManagedPresetPaths {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  return {
    sourceDir: join(packageRoot, 'preset'),
    targetDir: dshHome === undefined
      ? dshHomePath('.agent-presets', CLAUDE_CODE_PRESET_ID)
      : join(dshHome, '.agent-presets', CLAUDE_CODE_PRESET_ID),
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function atomicWrite(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await link(temporary, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await readIfPresent(path) === content) return false
      throw new ManagedPresetConflictError(path)
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function ensureManagedPreset(paths = defaultManagedPresetPaths()): Promise<'installed' | 'unchanged'> {
  await assertSafeTargetDirectory(paths.targetDir)
  const expected = await Promise.all(MANAGED_PRESET_FILES.map(async file => ({
    file,
    content: await readFile(join(paths.sourceDir, file), 'utf8'),
  })))
  let changed = false
  for (const { file, content } of expected) {
    const target = join(paths.targetDir, file)
    const current = await readIfPresent(target)
    if (current === content) continue
    if (current !== undefined) throw new ManagedPresetConflictError(target)
    changed = await atomicWrite(target, content) || changed
  }
  return changed ? 'installed' : 'unchanged'
}

/** Reject a target directory that is a symlink (or occupies the path as a file)
 *  so the managed preset never writes through an attacker-controlled link. */
async function assertSafeTargetDirectory(targetDir: string): Promise<void> {
  try {
    const stat = await lstat(targetDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ManagedPresetConflictError(targetDir)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

export async function removeManagedPreset(paths = defaultManagedPresetPaths()): Promise<'removed' | 'absent'> {
  await assertSafeTargetDirectory(paths.targetDir)
  let removed = false
  for (const file of MANAGED_PRESET_FILES) {
    const source = await readFile(join(paths.sourceDir, file), 'utf8')
    const target = join(paths.targetDir, file)
    const current = await readIfPresent(target)
    if (current === undefined) continue
    if (current !== source) throw new ManagedPresetConflictError(target)
    await rm(target)
    removed = true
  }
  try {
    if ((await readdir(paths.targetDir)).length === 0) await rmdir(paths.targetDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return removed ? 'removed' : 'absent'
}
