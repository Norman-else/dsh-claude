import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CLAUDE_CODE_PRESET_ID, LEGACY_CLAUDE_CODE_PRESET_ID } from './constants.ts'

export const MANAGED_PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/** Package specifier kept in the shipped template. DSH Desktop's resolver hook
 *  only rewrites bare specifiers issued by the root include; preset subtrees
 *  resolve through Node's internal loader with an unrelated base and cannot
 *  find linked packages. The installer therefore substitutes the absolute
 *  built entry path, which the preset tree imports directly as a file URL. */
const PRESET_ROUTE_PACKAGE_SPECIFIER = '@norman-else/dsh-claude/preset-route'

export class ManagedPresetConflictError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`dsh-claude: refusing to overwrite user-modified preset file ${path}`)
    this.name = 'ManagedPresetConflictError'
    this.path = path
  }
}

export interface ManagedPresetPaths {
  sourceDir: string
  targetDir: string
  legacyTargetDir?: string
}

export function defaultManagedPresetPaths(dshHome?: string): ManagedPresetPaths {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  return {
    sourceDir: join(packageRoot, 'preset'),
    targetDir: dshHome === undefined
      ? dshHomePath('.agent-presets', CLAUDE_CODE_PRESET_ID)
      : join(dshHome, '.agent-presets', CLAUDE_CODE_PRESET_ID),
    legacyTargetDir: dshHome === undefined
      ? dshHomePath('.agent-presets', LEGACY_CLAUDE_CODE_PRESET_ID)
      : join(dshHome, '.agent-presets', LEGACY_CLAUDE_CODE_PRESET_ID),
  }
}

interface ManagedContent {
  file: string
  /** Content this installer version writes. */
  content: string
  /** Older installer-written contents that may be silently upgraded/removed. */
  legacy: readonly string[]
  /** Legacy detection for contents that predate the current template. */
  isLegacy(current: string): boolean
}

async function managedContents(paths: ManagedPresetPaths): Promise<ManagedContent[]> {
  const routeEntry = join(paths.sourceDir, '..', 'lib', 'preset-route.mjs')
  return await Promise.all(MANAGED_PRESET_FILES.map(async (file): Promise<ManagedContent> => {
    const source = await readFile(join(paths.sourceDir, file), 'utf8')
    const nameRow = `name: '${PRESET_ROUTE_PACKAGE_SPECIFIER}'`
    const legacyNameRow = `name: ${PRESET_ROUTE_PACKAGE_SPECIFIER}`
    if (file !== 'agent.cordis.yml' || !source.includes(nameRow)) {
      return { file, content: source, legacy: [], isLegacy: () => false }
    }
    return {
      file,
      content: source.replace(nameRow, `name: '${routeEntry}'`),
      legacy: [source],
      // Any earlier installer generation wrote this same entry id with the
      // route reference in either supported form (bare package specifier or
      // absolute built-module path); treat those as safe to upgrade regardless
      // of comment or field drift in the template.
      isLegacy: current =>
        current.includes('id: claude-code-route')
        && (current.includes(nameRow)
          || current.includes(legacyNameRow)
          || current.includes('lib/preset-route.mjs')),
    }
  }))
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
  const expected = await managedContents(paths)
  let changed = false
  for (const { file, content, legacy, isLegacy } of expected) {
    const target = join(paths.targetDir, file)
    const current = await readIfPresent(target)
    if (current === content) continue
    if (current !== undefined) {
      // Upgrade installer-written legacy content in place; never touch user edits.
      if (!legacy.includes(current) && !isLegacy(current)) throw new ManagedPresetConflictError(target)
      await rm(target)
    }
    changed = await atomicWrite(target, content) || changed
  }
  if (paths.legacyTargetDir !== undefined) {
    changed = await removeLegacyManagedPreset(paths.legacyTargetDir) || changed
  }
  return changed ? 'installed' : 'unchanged'
}

async function removeLegacyManagedPreset(targetDir: string): Promise<boolean> {
  await assertSafeTargetDirectory(targetDir)
  const agent = await readIfPresent(join(targetDir, 'agent.cordis.yml'))
  const preset = await readIfPresent(join(targetDir, 'preset.yml'))
  if (agent === undefined && preset === undefined) return false

  // Only migrate the prior installer-owned template. Any user edit leaves the
  // complete legacy preset untouched so existing sessions remain recoverable.
  const managedAgent = agent !== undefined
    && agent.includes('id: claude-code-route')
    && (agent.includes('dsh-claude-code/preset-route') || agent.includes('lib/preset-route.mjs'))
  const managedPreset = preset !== undefined
    && preset.includes('Managed by dsh-claude-code')
    && preset.includes('name: Claude Code')
  if (!managedAgent || !managedPreset) return false

  await rm(join(targetDir, 'agent.cordis.yml'))
  await rm(join(targetDir, 'preset.yml'))
  if ((await readdir(targetDir)).length === 0) await rmdir(targetDir)
  return true
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
  const expected = await managedContents(paths)
  let removed = false
  for (const { file, content, legacy, isLegacy } of expected) {
    const target = join(paths.targetDir, file)
    const current = await readIfPresent(target)
    if (current === undefined) continue
    if (current !== content && !legacy.includes(current) && !isLegacy(current)) throw new ManagedPresetConflictError(target)
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
