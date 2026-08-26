import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { chmod, mkdir, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CLAUDE_GLOBAL_SETTINGS_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'

const MAX_SETTINGS_BYTES = 256 * 1024
const MAX_REQUEST_BYTES = 8 * 1024
const MAX_STYLE_BYTES = 64 * 1024
const MAX_STYLE_FILES = 256
const BUILTIN_OUTPUT_STYLES = ['Default', 'Proactive', 'Concise', 'Explanatory', 'Learning'] as const
const STYLE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()\[\]-]{0,127}$/u
const DEFAULT_WORKTREE_BRANCH_PREFIX = 'claude'
const MAX_BRANCH_PREFIX_CHARS = 128
const MAX_PROCESSES_LIMIT = 16
const MAX_IDLE_TIMEOUT_MINUTES = 24 * 60
const DEFAULT_LIMITS: SupervisorLimits = { maxProcesses: 4, idleTimeoutMs: 30 * 60_000 }

type JsonObject = Record<string, unknown>
export type GlobalSettingEffect = 'new-session' | 'next-worktree' | 'restart'

export interface GlobalSettingOption {
  value: string
  label: string
  source: 'built-in' | 'user' | 'configured'
}

export type GlobalSettingView = {
  key: string
  kind: 'select'
  value: string
  options: readonly GlobalSettingOption[]
  effect: GlobalSettingEffect
} | {
  key: string
  kind: 'text'
  value: string
  maxLength: number
  effect: GlobalSettingEffect
}

export interface GlobalSettingsView {
  settings: readonly GlobalSettingView[]
}

interface GlobalSettingsPaths {
  settingsFile: string
  outputStylesDir: string
  pluginSettingsFile: string
}

/** Effective supervisor limits: the plugin config values unless overridden in Settings. */
export interface SupervisorLimits {
  maxProcesses: number
  idleTimeoutMs: number
}

export interface GlobalSettingsDependencies {
  paths?: Partial<GlobalSettingsPaths>
  /** Limits from the plugin config, shown when Settings holds no override. */
  defaultLimits?: SupervisorLimits
  /** Invoked after a successful update so live runtime state can follow. */
  onUpdated?: () => void | Promise<void>
}

interface SelectSettingDescriptor {
  key: string
  kind: 'select'
  document: 'claude' | 'plugin'
  effect: GlobalSettingEffect
  options(paths: GlobalSettingsPaths): Promise<readonly GlobalSettingOption[]>
  read(document: JsonObject, options: readonly GlobalSettingOption[]): string
  apply(document: JsonObject, value: unknown, options: readonly GlobalSettingOption[]): void
}

interface TextSettingDescriptor {
  key: string
  kind: 'text'
  document: 'claude' | 'plugin'
  effect: GlobalSettingEffect
  maxLength: number
  read(document: JsonObject, defaults?: SupervisorLimits): string
  apply(document: JsonObject, value: unknown): void
}

type SettingDescriptor = SelectSettingDescriptor | TextSettingDescriptor

function pathsFor(deps: GlobalSettingsDependencies): GlobalSettingsPaths {
  const root = join(homedir(), '.claude')
  return {
    settingsFile: deps.paths?.settingsFile ?? join(root, 'settings.json'),
    outputStylesDir: deps.paths?.outputStylesDir ?? join(root, 'output-styles'),
    pluginSettingsFile: deps.paths?.pluginSettingsFile ?? dshHomePath('plugins', 'dsh-claude', 'settings.json'),
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

async function readDocument(path: string): Promise<JsonObject> {
  try {
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) throw new Error('Claude Code settings file is too large')
    const parsed = object(JSON.parse(text))
    if (parsed === undefined) throw new Error('Claude Code settings file must contain a JSON object')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function frontmatterName(text: string): string | undefined {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return undefined
  const normalized = text.replaceAll('\r\n', '\n')
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return undefined
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^name:\s*(.+?)\s*$/.exec(line)
    if (match?.[1] === undefined) continue
    const raw = match[1]
    const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw
    return STYLE_NAME.test(value) ? value : undefined
  }
  return undefined
}

async function userOutputStyleOptions(directory: string): Promise<GlobalSettingOption[]> {
  const options: GlobalSettingOption[] = []
  let entries
  try {
    entries = await opendir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return options
    throw error
  }
  for await (const entry of entries) {
    if (options.length >= MAX_STYLE_FILES) break
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    try {
      const text = await readFile(join(directory, entry.name), 'utf8')
      if (Buffer.byteLength(text) > MAX_STYLE_BYTES) continue
      const name = frontmatterName(text) ?? entry.name.slice(0, -3)
      if (STYLE_NAME.test(name)) options.push({ value: name, label: name, source: 'user' })
    } catch {
      // Ignore unreadable or malformed optional style files.
    }
  }
  return options
}

const OUTPUT_STYLE: SettingDescriptor = {
  key: 'outputStyle',
  kind: 'select',
  document: 'claude',
  effect: 'new-session',
  async options(paths) {
    const builtIn = BUILTIN_OUTPUT_STYLES.map(value => ({ value, label: value, source: 'built-in' as const }))
    const user = await userOutputStyleOptions(paths.outputStylesDir)
    const seen = new Set<string>(builtIn.map(option => option.value))
    return [...builtIn, ...user.filter(option => !seen.has(option.value)).sort((a, b) => a.label.localeCompare(b.label))]
  },
  read(document, options) {
    const value = document.outputStyle
    return typeof value === 'string' && STYLE_NAME.test(value) ? value : 'Default'
  },
  apply(document, value, options) {
    if (typeof value !== 'string' || !options.some(option => option.value === value)) {
      throw new Error('Invalid value for global setting outputStyle')
    }
    if (value === 'Default') delete document.outputStyle
    else document.outputStyle = value
  },
}

export function isValidWorktreeBranchPrefix(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_BRANCH_PREFIX_CHARS
    && value.trim() === value
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('//')
    && !value.includes('..')
    && !value.includes('@{')
    && !/[\0-\x20\x7f~^:?*[\\]/u.test(value)
    && value.split('/').every(segment => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'))
}

const WORKTREE_BRANCH_PREFIX: TextSettingDescriptor = {
  key: 'worktreeBranchPrefix',
  kind: 'text',
  document: 'plugin',
  effect: 'next-worktree',
  maxLength: MAX_BRANCH_PREFIX_CHARS,
  read(document) {
    const value = document.worktreeBranchPrefix
    return typeof value === 'string' && isValidWorktreeBranchPrefix(value) ? value : DEFAULT_WORKTREE_BRANCH_PREFIX
  },
  apply(document, value) {
    if (typeof value !== 'string' || !isValidWorktreeBranchPrefix(value)) {
      throw new Error('Invalid value for global setting worktreeBranchPrefix')
    }
    if (value === DEFAULT_WORKTREE_BRANCH_PREFIX) delete document.worktreeBranchPrefix
    else document.worktreeBranchPrefix = value
  },
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function integerSetting(
  key: 'maxProcesses' | 'idleTimeoutMinutes',
  min: number,
  max: number,
  defaultFor: (limits: SupervisorLimits) => number,
): TextSettingDescriptor {
  return {
    key,
    kind: 'text',
    document: 'plugin',
    effect: 'new-session',
    maxLength: String(max).length,
    read(document, defaults = DEFAULT_LIMITS) {
      const value = document[key]
      return String(isBoundedInteger(value, min, max) ? value : defaultFor(defaults))
    },
    apply(document, value) {
      const parsed = typeof value === 'string' && /^\d{1,6}$/u.test(value.trim()) ? Number(value.trim()) : value
      if (!isBoundedInteger(parsed, min, max)) throw new Error(`Invalid value for global setting ${key}`)
      document[key] = parsed
    },
  }
}

const MAX_PROCESSES = integerSetting('maxProcesses', 1, MAX_PROCESSES_LIMIT, limits => limits.maxProcesses)
const IDLE_TIMEOUT_MINUTES = integerSetting('idleTimeoutMinutes', 1, MAX_IDLE_TIMEOUT_MINUTES, limits => Math.max(1, Math.round(limits.idleTimeoutMs / 60_000)))

const DESCRIPTORS: readonly SettingDescriptor[] = [OUTPUT_STYLE, WORKTREE_BRANCH_PREFIX, MAX_PROCESSES, IDLE_TIMEOUT_MINUTES]
const DESCRIPTOR_BY_KEY = new Map(DESCRIPTORS.map(descriptor => [descriptor.key, descriptor]))
let pendingWrite: Promise<unknown> = Promise.resolve()

function documentFor(descriptor: SettingDescriptor, documents: { claude: JsonObject; plugin: JsonObject }): JsonObject {
  return documents[descriptor.document]
}

async function views(documents: { claude: JsonObject; plugin: JsonObject }, paths: GlobalSettingsPaths, defaults: SupervisorLimits): Promise<GlobalSettingsView> {
  return {
    settings: await Promise.all(DESCRIPTORS.map(async descriptor => {
      const document = documentFor(descriptor, documents)
      if (descriptor.kind === 'text') {
        return {
          key: descriptor.key,
          kind: descriptor.kind,
          value: descriptor.read(document, defaults),
          maxLength: descriptor.maxLength,
          effect: descriptor.effect,
        }
      }
      const discovered = await descriptor.options(paths)
      const value = descriptor.read(document, discovered)
      const options = discovered.some(option => option.value === value)
        ? discovered
        : [...discovered, { value, label: value, source: 'configured' as const }]
      return {
        key: descriptor.key,
        kind: descriptor.kind,
        value,
        options,
        effect: descriptor.effect,
      }
    })),
  }
}

async function readDocuments(paths: GlobalSettingsPaths): Promise<{ claude: JsonObject; plugin: JsonObject }> {
  const [claude, plugin] = await Promise.all([readDocument(paths.settingsFile), readDocument(paths.pluginSettingsFile)])
  return { claude, plugin }
}

export async function readGlobalSettings(deps: GlobalSettingsDependencies = {}): Promise<GlobalSettingsView> {
  const paths = pathsFor(deps)
  return views(await readDocuments(paths), paths, deps.defaultLimits ?? DEFAULT_LIMITS)
}

/** Supervisor limits the user overrode in Settings; absent keys fall back to the plugin config. */
export async function readSupervisorLimitOverrides(deps: GlobalSettingsDependencies = {}): Promise<Partial<SupervisorLimits>> {
  let document: JsonObject
  try {
    document = await readDocument(pathsFor(deps).pluginSettingsFile)
  } catch {
    return {}
  }
  const maxProcesses = document.maxProcesses
  const idleTimeoutMinutes = document.idleTimeoutMinutes
  return {
    ...(isBoundedInteger(maxProcesses, 1, MAX_PROCESSES_LIMIT) ? { maxProcesses } : {}),
    ...(isBoundedInteger(idleTimeoutMinutes, 1, MAX_IDLE_TIMEOUT_MINUTES) ? { idleTimeoutMs: idleTimeoutMinutes * 60_000 } : {}),
  }
}

export async function readWorktreeBranchPrefix(deps: GlobalSettingsDependencies = {}): Promise<string> {
  const paths = pathsFor(deps)
  return WORKTREE_BRANCH_PREFIX.read(await readDocument(paths.pluginSettingsFile))
}

async function atomicWrite(path: string, document: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export function updateGlobalSettings(changes: unknown, deps: GlobalSettingsDependencies = {}): Promise<GlobalSettingsView> {
  const changeObject = object(changes)
  if (changeObject === undefined || Object.keys(changeObject).length === 0) {
    return Promise.reject(new Error('Global settings changes must be a non-empty object'))
  }
  for (const key of Object.keys(changeObject)) {
    if (!DESCRIPTOR_BY_KEY.has(key)) return Promise.reject(new Error(`Unsupported global setting: ${key}`))
  }
  const paths = pathsFor(deps)
  const operation = pendingWrite.catch(() => undefined).then(async () => {
    const documents = await readDocuments(paths)
    const changedDocuments = new Set<'claude' | 'plugin'>()
    for (const [key, value] of Object.entries(changeObject)) {
      const descriptor = DESCRIPTOR_BY_KEY.get(key)!
      const document = documentFor(descriptor, documents)
      if (descriptor.kind === 'select') descriptor.apply(document, value, await descriptor.options(paths))
      else descriptor.apply(document, value)
      changedDocuments.add(descriptor.document)
    }
    if (changedDocuments.has('claude')) await atomicWrite(paths.settingsFile, documents.claude)
    if (changedDocuments.has('plugin')) await atomicWrite(paths.pluginSettingsFile, documents.plugin)
    return views(documents, paths, deps.defaultLimits ?? DEFAULT_LIMITS)
  })
  pendingWrite = operation
  return operation
}

async function requestJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) throw new Error('Request body is too large')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Request body is too large')
    chunks.push(data)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  const body = object(value)
  if (body === undefined || Object.keys(body).some(key => key !== 'changes')) throw new Error('Invalid global settings request')
  return body.changes
}

export function registerClaudeGlobalSettingsRoute(ctx: Context, deps: GlobalSettingsDependencies = {}): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_GLOBAL_SETTINGS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'PATCH') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const result = req.method === 'GET'
          ? await readGlobalSettings(deps)
          : await updateGlobalSettings(await requestJson(req), deps)
        if (req.method === 'PATCH') await deps.onUpdated?.()
        json(res, 200, result)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : 'Invalid global settings request' })
      }
    },
  }), 'dsh-claude: global settings')
}
