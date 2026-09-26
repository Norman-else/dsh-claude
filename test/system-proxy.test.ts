import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { hasProxyEnv, parseWindowsInternetSettings, withSystemProxy } from '../src/system-proxy.ts'

const REG = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:7890',
  '    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;10.*;*.internal.example.com;<local>',
  '',
].join('\r\n')

describe('Windows system proxy', () => {
  it('turns the WinINet proxy into HTTP(S)_PROXY and NO_PROXY', () => {
    expect(parseWindowsInternetSettings(REG)).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1,127.0.0.0/8,192.168.0.0/16,10.0.0.0/8,.internal.example.com',
    })
  })

  it('yields nothing while the proxy is switched off', () => {
    expect(parseWindowsInternetSettings(REG.replace('0x1', '0x0'))).toBeUndefined()
  })

  it('prefers the HTTPS entry of a per-scheme list and ignores SOCKS-only settings', () => {
    const perScheme = REG.replace('127.0.0.1:7890', 'http=proxy:80;https=secure:443;socks=s:1080')
    expect(parseWindowsInternetSettings(perScheme)?.HTTPS_PROXY).toBe('http://secure:443')
    expect(parseWindowsInternetSettings(REG.replace('127.0.0.1:7890', 'socks=s:1080'))).toBeUndefined()
  })

  it('recognises a proxy already present under any case', () => {
    expect(hasProxyEnv({ https_proxy: 'http://p:1' })).toBe(true)
    expect(hasProxyEnv({ HTTPS_PROXY: ' ' })).toBe(false)
    expect(hasProxyEnv({ PATH: '/bin' })).toBe(false)
  })
})

describe('withSystemProxy', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const spec = (env?: Record<string, string>): SubprocessSpawnSpec => ({
    argv: ['claude'],
    cwd: '/',
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 0,
    ...(env === undefined ? {} : { env }),
  }) as SubprocessSpawnSpec

  function recording() {
    const specs: SubprocessSpawnSpec[] = []
    const runtime = { spawn: (value: SubprocessSpawnSpec) => { specs.push(value); return {} } } as unknown as SubprocessRuntime
    return { runtime, specs }
  }

  it('adds the system proxy to a child that has none', () => {
    vi.stubEnv('HTTPS_PROXY', '')
    vi.stubEnv('HTTP_PROXY', '')
    vi.stubEnv('ALL_PROXY', '')
    const { runtime, specs } = recording()
    withSystemProxy(runtime, () => parseWindowsInternetSettings(REG)).spawn(spec({ FOO: '1' }))
    expect(specs[0]!.env).toMatchObject({ FOO: '1', HTTPS_PROXY: 'http://127.0.0.1:7890' })
  })

  it('leaves a proxy configured by the Host or the caller alone', () => {
    const { runtime, specs } = recording()
    const wrapped = withSystemProxy(runtime, () => parseWindowsInternetSettings(REG))
    wrapped.spawn(spec({ HTTPS_PROXY: 'http://own:1' }))
    vi.stubEnv('HTTPS_PROXY', 'http://host:2')
    wrapped.spawn(spec())
    expect(specs[0]!.env).toEqual({ HTTPS_PROXY: 'http://own:1' })
    expect(specs[1]!.env).toBeUndefined()
  })
})
