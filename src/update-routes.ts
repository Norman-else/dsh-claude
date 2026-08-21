import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { opendir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_UPDATE_CHECK_PATH, CLAUDE_UPDATE_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { json, trustedRequest } from './http.ts'

export const PLUGIN_PACKAGE_NAME = '@norman-else/dsh-claude'
export const UPDATE_TIMEOUT_MS = 30_000
const CHECK_TIMEOUT_MS = 10_000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_UPDATE_OUTPUT_BYTES = 32 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type InstallSource = 'registry' | 'link' | 'unsupported' | 'unknown'
export type UpdateState = 'current' | 'available' | 'linked' | 'unsupported' | 'unavailable' | 'error'

export interface PluginUpdateStatus {
  currentVersion: string
  latestVersion?: string
  source: InstallSource
  state: UpdateState
  canUpdate: boolean
  restartRequired: boolean
  message?: string
}

interface PackageManifest {
  name?: unknown
  version?: unknown
  dependencies?: unknown
}

export interface Installation {
  profile: string
  profileDir: string
  source: InstallSource
  spec: string
}

export interface UpdateDependencies {
  packageDir?: string
  dshHome?: string
  fetchLatest?: (signal: AbortSignal) => Promise<string>
  resolveExecutable?: (name: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<string>
  spawn?: SubprocessRuntime['spawn']
}

function safeMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 500)
}

async function readManifest(path: string): Promise<PackageManifest> {
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('package manifest is too large')
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('package manifest is invalid')
  return value as PackageManifest
}

function dependencySpec(manifest: PackageManifest): string | undefined {
  if (typeof manifest.dependencies !== 'object' || manifest.dependencies === null || Array.isArray(manifest.dependencies)) return undefined
  const value = (manifest.dependencies as Record<string, unknown>)[PLUGIN_PACKAGE_NAME]
  return typeof value === 'string' && value.length <= 2_000 ? value : undefined
}

export function classifyInstallSpec(spec: string): InstallSource {
  if (/^(?:link|file|workspace):/i.test(spec)) return 'link'
  if (/^(?:git(?:\+[^:]+)?:|github:|https?:|npm:)/i.test(spec) || /\.git(?:#|$)/i.test(spec)) return 'unsupported'
  return /^(?:\^|~|>=?|<=?|=)?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s*\|\|\s*(?:\^|~|>=?|<=?|=)?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)*$/.test(spec.trim())
    ? 'registry'
    : 'unsupported'
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)])
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

function linkedTarget(profileDir: string, spec: string): string | undefined {
  const match = /^(?:link|file):(.*)$/i.exec(spec)
  return match?.[1] === undefined ? undefined : resolve(profileDir, match[1])
}

export async function discoverInstallation(dshHome: string, packageDir: string): Promise<Installation | undefined> {
  const profilesDir = join(dshHome, 'profiles')
  const matches: Installation[] = []
  let profiles
  try {
    profiles = await opendir(profilesDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  for await (const entry of profiles) {
    if (!entry.isDirectory() || !PROFILE_NAME.test(entry.name)) continue
    const profileDir = join(profilesDir, entry.name)
    let manifest: PackageManifest
    try {
      manifest = await readManifest(join(profileDir, 'package.json'))
    } catch {
      continue
    }
    const spec = dependencySpec(manifest)
    if (spec === undefined) continue
    const source = classifyInstallSpec(spec)
    const matchesPackage = source === 'link'
      ? linkedTarget(profileDir, spec) !== undefined && await samePath(linkedTarget(profileDir, spec)!, packageDir)
      : await samePath(join(profileDir, 'node_modules', ...PLUGIN_PACKAGE_NAME.split('/')), packageDir)
    if (matchesPackage) matches.push({ profile: entry.name, profileDir, source, spec })
  }
  return matches.length === 1 ? matches[0] : undefined
}

function parseVersion(version: string): RegExpExecArray {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error('package version is not valid semver')
  return match
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return Math.sign(difference)
  }
  const aPre = a[4]
  const bPre = b[4]
  if (aPre === undefined) return bPre === undefined ? 0 : 1
  if (bPre === undefined) return -1
  return aPre.localeCompare(bPre, 'en', { numeric: true })
}

async function registryLatest(signal: AbortSignal): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/%40norman-else%2Fdsh-claude', {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal,
  })
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
  const payload = await response.json() as { 'dist-tags'?: { latest?: unknown } }
  const latest = payload['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error('npm registry response has no latest version')
  parseVersion(latest)
  return latest
}

async function resolvePackageContextDir(configured?: string): Promise<{ packageDir: string; manifest: PackageManifest }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = configured === undefined ? [moduleDir, dirname(moduleDir)] : [configured]
  for (const packageDir of candidates) {
    try {
      const manifest = await readManifest(join(packageDir, 'package.json'))
      if (manifest.name === PLUGIN_PACKAGE_NAME) return { packageDir, manifest }
    } catch {
      // Continue until the owning package manifest is found.
    }
  }
  throw new Error('plugin package manifest is invalid')
}

async function packageContext(deps: UpdateDependencies): Promise<{ version: string; installation?: Installation }> {
  const { packageDir, manifest } = await resolvePackageContextDir(deps.packageDir)
  if (typeof manifest.version !== 'string') throw new Error('plugin package manifest is invalid')
  parseVersion(manifest.version)
  const home = deps.dshHome ?? resolveDshHome()
  const installation = await discoverInstallation(home, packageDir)
  return { version: manifest.version, ...(installation === undefined ? {} : { installation }) }
}

export async function checkPluginUpdate(deps: UpdateDependencies = {}): Promise<PluginUpdateStatus> {
  try {
    const { version, installation } = await packageContext(deps)
    if (installation === undefined) return { currentVersion: version, source: 'unknown', state: 'unavailable', canUpdate: false, restartRequired: false, message: 'Active DSH profile could not be identified uniquely' }
    if (installation.source === 'link') return { currentVersion: version, source: 'link', state: 'linked', canUpdate: false, restartRequired: false, message: 'Local development link; updates come from the linked checkout' }
    if (installation.source !== 'registry') return { currentVersion: version, source: installation.source, state: 'unsupported', canUpdate: false, restartRequired: false, message: 'This installation source cannot be updated from the npm registry' }
    const latest = await (deps.fetchLatest ?? registryLatest)(AbortSignal.timeout(CHECK_TIMEOUT_MS))
    const comparison = compareVersions(version, latest)
    return {
      currentVersion: version,
      latestVersion: latest,
      source: 'registry',
      state: comparison < 0 ? 'available' : 'current',
      canUpdate: comparison < 0,
      restartRequired: comparison < 0,
    }
  } catch (error) {
    return { currentVersion: 'unknown', source: 'unknown', state: 'error', canUpdate: false, restartRequired: false, message: safeMessage(error) }
  }
}

async function verifyInstalledVersion(installation: Installation, expectedVersion: string): Promise<void> {
  const profileManifest = await readManifest(join(installation.profileDir, 'package.json'))
  if (dependencySpec(profileManifest) !== expectedVersion) {
    throw new Error('DSH plugin update completed without updating the profile dependency')
  }
  const installedManifest = await readManifest(join(
    installation.profileDir,
    'node_modules',
    ...PLUGIN_PACKAGE_NAME.split('/'),
    'package.json',
  ))
  if (installedManifest.name !== PLUGIN_PACKAGE_NAME || installedManifest.version !== expectedVersion) {
    throw new Error('DSH plugin update completed without installing the requested version')
  }
}

export async function updatePlugin(deps: UpdateDependencies = {}): Promise<PluginUpdateStatus> {
  const { version, installation } = await packageContext(deps)
  if (installation === undefined || installation.source !== 'registry') throw new Error('Plugin update is unavailable for this installation')
  const latest = await (deps.fetchLatest ?? registryLatest)(AbortSignal.timeout(CHECK_TIMEOUT_MS))
  if (compareVersions(version, latest) >= 0) return { currentVersion: version, latestVersion: latest, source: 'registry', state: 'current', canUpdate: false, restartRequired: false }
  const resolveExecutable = deps.resolveExecutable
  const spawn = deps.spawn
  if (resolveExecutable === undefined || spawn === undefined) throw new Error('DSH update runtime is unavailable')
  const signal = AbortSignal.timeout(UPDATE_TIMEOUT_MS)
  const executable = await resolveExecutable('dsh', {}, signal)
  const handle = spawn({
    argv: [executable, 'plugin', '--profile', installation.profile, 'add', `${PLUGIN_PACKAGE_NAME}@${latest}`],
    cwd: installation.profileDir,
    env: {},
    stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_UPDATE_OUTPUT_BYTES }, stderr: { maxBytes: MAX_UPDATE_OUTPUT_BYTES } },
    graceMs: 2_000,
    signal,
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0) {
    const detail = handle.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(`DSH plugin update failed (${outcome.exitCode ?? outcome.signal ?? 'unknown exit'}): ${safeMessage(detail)}`)
  }
  await verifyInstalledVersion(installation, latest)
  return { currentVersion: latest, latestVersion: latest, source: 'registry', state: 'current', canUpdate: false, restartRequired: true, message: 'Update installed; restart DSH Desktop to load it' }
}

export function registerClaudeUpdateRoutes(ctx: Context, runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>, deps: UpdateDependencies = {}): void {
  const shared: UpdateDependencies = { ...deps, resolveExecutable: runtime.resolveExecutable.bind(runtime), spawn: runtime.spawn.bind(runtime) }
  for (const route of [
    { path: CLAUDE_UPDATE_CHECK_PATH, method: 'GET', run: () => checkPluginUpdate(shared) },
    { path: CLAUDE_UPDATE_PATH, method: 'POST', run: () => updatePlugin(shared) },
  ]) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        if (req.method !== route.method) return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        try {
          json(res, 200, await route.run())
        } catch (error) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }), `dsh-claude: ${route.method} ${route.path}`)
  }
}
