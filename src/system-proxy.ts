import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Proxy variables handed to child processes that read none of their own. */
export type ProxyEnv = Readonly<Record<'HTTPS_PROXY' | 'HTTP_PROXY', string>> & { readonly NO_PROXY?: string }

const PROXY_NAMES = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'])
const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1']
const REG_QUERY_TIMEOUT_MS = 3_000

/** Whether an environment already routes traffic through a proxy of its own. */
export function hasProxyEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return Object.entries(env).some(([name, value]) => PROXY_NAMES.has(name.toUpperCase()) && value !== undefined && value.trim() !== '')
}

function proxyUrl(server: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(server) ? server : `http://${server}`
}

/** `10.*` → `10.0.0.0/8`; `*.corp.example` → `.corp.example`; `<local>` and
 *  other wildcards have no NO_PROXY spelling and are dropped. */
function noProxyEntry(pattern: string): string | undefined {
  const entry = pattern.trim()
  if (entry === '' || entry === '<local>') return undefined
  const ip = /^(\d{1,3}(?:\.\d{1,3}){0,3})\.\*$/u.exec(entry)
  if (ip !== null) {
    const octets = ip[1]!.split('.')
    return `${[...octets, '0', '0', '0'].slice(0, 4).join('.')}/${octets.length * 8}`
  }
  if (entry.startsWith('*.') && !entry.slice(2).includes('*')) return entry.slice(1)
  return entry.includes('*') ? undefined : entry
}

/** Read the WinINet proxy from `reg query` output.
 *
 *  `ProxyServer` is either one `host:port` for every scheme or a
 *  `scheme=host:port;…` list; the HTTPS entry wins, then HTTP. A SOCKS-only
 *  setting is not expressible as HTTP(S)_PROXY and yields nothing. */
export function parseWindowsInternetSettings(output: string): ProxyEnv | undefined {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/u.exec(line)
    if (match !== null) values.set(match[1]!, match[2]!)
  }
  if (Number(values.get('ProxyEnable')) !== 1) return undefined
  const server = values.get('ProxyServer')?.trim()
  if (server === undefined || server === '') return undefined
  let target = server
  if (server.includes('=')) {
    const byScheme = new Map(server.split(';').map(part => {
      const [scheme, address] = part.split('=', 2)
      return [scheme?.trim().toLowerCase() ?? '', address?.trim() ?? ''] as const
    }))
    const chosen = byScheme.get('https') || byScheme.get('http')
    if (chosen === undefined || chosen === '') return undefined
    target = chosen
  }
  const url = proxyUrl(target)
  const bypass = (values.get('ProxyOverride') ?? '').split(';').map(noProxyEntry).filter((entry): entry is string => entry !== undefined)
  const noProxy = [...new Set([...ALWAYS_DIRECT, ...bypass])].join(',')
  return { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: noProxy }
}

/** The Windows system proxy, or undefined off Windows, when disabled, or when
 *  the registry cannot be read. Never throws: a missing proxy only means the
 *  children connect directly, as they did before. */
export async function detectWindowsSystemProxy(
  runtime: Pick<SubprocessRuntime, 'spawn'>,
  platform: NodeJS.Platform = process.platform,
): Promise<ProxyEnv | undefined> {
  if (platform !== 'win32') return undefined
  try {
    const handle = runtime.spawn({
      argv: [`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\reg.exe`, 'query', INTERNET_SETTINGS_KEY],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 4 * 1024 } },
      graceMs: 500,
      signal: AbortSignal.timeout(REG_QUERY_TIMEOUT_MS),
      env: {},
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    return parseWindowsInternetSettings(handle.collected.stdout?.readFrom(0).text ?? '')
  } catch {
    return undefined
  }
}

/**
 * Give child processes the system proxy when nothing else configured one.
 *
 * DSH Desktop copies the Windows system proxy into its Host's environment; the
 * official DeepSeek Harness app does not (it reads only `~/.dsh/.env`), so
 * Claude Code, git, and gh connected directly and Anthropic refused the
 * request ("403 Request not allowed"). A proxy already present in the Host or
 * in the spawn spec always wins.
 */
export function withSystemProxy(runtime: SubprocessRuntime, proxy: () => ProxyEnv | undefined): SubprocessRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== 'spawn') {
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      }
      return (spec: SubprocessSpawnSpec) => {
        const env = proxy()
        if (env === undefined || hasProxyEnv(process.env) || hasProxyEnv(spec.env ?? {})) return target.spawn(spec)
        return target.spawn({ ...spec, env: { ...env, ...spec.env } })
      }
    },
  })
}
