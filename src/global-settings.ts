import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { chmod, mkdir, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_GLOBAL_SETTINGS_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'

const MAX_SETTINGS_BYTES = 256 * 1024
const MAX_REQUEST_BYTES = 8 * 1024
const MAX_STYLE_BYTES = 64 * 1024
const MAX_STYLE_FILES = 256
const BUILTIN_OUTPUT_STYLES = ['Default', 'Proactive', 'Concise', 'Explanatory', 'Learning'] as const
const STYLE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()\[\]-]{0,127}$/u

type JsonObject = Record<string, unknown>
export type GlobalSettingEffect = 'new-session' | 'restart'

export interface GlobalSettingOption {
  value: string
  label: string
  source: 'built-in' | 'user' | 'configured'
}

export interface GlobalSettingView {
  key: string
  kind: 'select'
  value: string
  options: readonly GlobalSettingOption[]
  effect: GlobalSettingEffect
}

export interface GlobalSettingsView {
  settings: readonly GlobalSettingView[]
}

interface GlobalSettingsPaths {
  settingsFile: string
  outputStylesDir: string
}

export interface GlobalSettingsDependencies {
  paths?: Partial<GlobalSettingsPaths>
}

interface SettingDescriptor {
  key: string
  kind: 'select'
  effect: GlobalSettingEffect
  options(paths: GlobalSettingsPaths): Promise<readonly GlobalSettingOption[]>
  read(document: JsonObject, options: readonly GlobalSettingOption[]): string
  apply(document: JsonObject, value: unknown, options: readonly GlobalSettingOption[]): void
}

function pathsFor(deps: GlobalSettingsDependencies): GlobalSettingsPaths {
  const root = join(homedir(), '.claude')
  return {
    settingsFile: deps.paths?.settingsFile ?? join(root, 'settings.json'),
    outputStylesDir: deps.paths?.outputStylesDir ?? join(root, 'output-styles'),
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

const DESCRIPTORS: readonly SettingDescriptor[] = [OUTPUT_STYLE]
const DESCRIPTOR_BY_KEY = new Map(DESCRIPTORS.map(descriptor => [descriptor.key, descriptor]))
let pendingWrite: Promise<unknown> = Promise.resolve()

async function views(document: JsonObject, paths: GlobalSettingsPaths): Promise<GlobalSettingsView> {
  return {
    settings: await Promise.all(DESCRIPTORS.map(async descriptor => {
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

export async function readGlobalSettings(deps: GlobalSettingsDependencies = {}): Promise<GlobalSettingsView> {
  const paths = pathsFor(deps)
  return views(await readDocument(paths.settingsFile), paths)
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
    const document = await readDocument(paths.settingsFile)
    for (const [key, value] of Object.entries(changeObject)) {
      const descriptor = DESCRIPTOR_BY_KEY.get(key)!
      descriptor.apply(document, value, await descriptor.options(paths))
    }
    await atomicWrite(paths.settingsFile, document)
    return views(document, paths)
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
        json(res, 200, result)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : 'Invalid global settings request' })
      }
    },
  }), 'dsh-claude: global settings')
}
