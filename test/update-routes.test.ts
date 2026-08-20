import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  checkPluginUpdate,
  classifyInstallSpec,
  compareVersions,
  discoverInstallation,
  PLUGIN_PACKAGE_NAME,
  registerClaudeUpdateRoutes,
  updatePlugin,
} from '../src/update-routes.ts'
import { isPluginUpdateStatus } from '../src/client/ClaudeCodeSettings.tsx'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(version = '1.0.0'): Promise<{ root: string; home: string; packageDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-update-'))
  roots.push(root)
  const home = join(root, 'home')
  const packageDir = join(root, 'plugin')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version }))
  return { root, home, packageDir }
}

async function profile(home: string, name: string, spec: string, packageDir: string, link = false): Promise<string> {
  const profileDir = join(home, 'profiles', name)
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN_PACKAGE_NAME]: spec } }))
  if (!link) {
    const installed = join(profileDir, 'node_modules', ...PLUGIN_PACKAGE_NAME.split('/'))
    await mkdir(dirname(installed), { recursive: true })
    await symlink(packageDir, installed, 'junction')
  }
  return profileDir
}

function handle(exitCode = 0, stderr = ''): SubprocessHandle {
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    collected: {
      stdout: undefined,
      stderr: { readFrom: () => ({ text: stderr }) },
    },
  } as unknown as SubprocessHandle
}

function routeContext(): Context & { routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> } {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  return {
    routes,
    effect: (register: () => unknown) => { register() },
    webServer: {
      register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  } as unknown as Context & { routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> }
}

function request(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers, socket: { remoteAddress: '::1' } } as unknown as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode: number) { this.statusCode = statusCode },
    end(body: string) { this.body = body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('plugin update discovery', () => {
  it('classifies supported registry and non-registry specs', () => {
    expect(classifyInstallSpec('^1.2.3')).toBe('registry')
    expect(classifyInstallSpec('link:C:/source')).toBe('link')
    expect(classifyInstallSpec('file:../source')).toBe('link')
    expect(classifyInstallSpec('github:owner/repo')).toBe('unsupported')
    expect(classifyInstallSpec('npm:another@1.2.3')).toBe('unsupported')
  })

  it('compares releases and prereleases', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('reports a matching local development link without querying npm', async () => {
    const { home, packageDir } = await fixture('0.1.7')
    await profile(home, 'desktop', `link:${packageDir}`, packageDir, true)
    const fetchLatest = vi.fn(async () => '9.9.9')
    const status = await checkPluginUpdate({ dshHome: home, packageDir, fetchLatest })
    expect(status).toMatchObject({ currentVersion: '0.1.7', source: 'link', state: 'linked', canUpdate: false })
    expect(fetchLatest).not.toHaveBeenCalled()
  })

  it('reports an available npm update for one matching profile', async () => {
    const { home, packageDir } = await fixture('1.0.0')
    await profile(home, 'desktop', '^1.0.0', packageDir)
    const status = await checkPluginUpdate({ dshHome: home, packageDir, fetchLatest: async () => '1.1.0' })
    expect(status).toMatchObject({ currentVersion: '1.0.0', latestVersion: '1.1.0', source: 'registry', state: 'available', canUpdate: true, restartRequired: true })
  })

  it('disables updates when more than one profile resolves to the package', async () => {
    const { home, packageDir } = await fixture()
    await profile(home, 'desktop', '^1.0.0', packageDir)
    await profile(home, 'web', '^1.0.0', packageDir)
    expect(await discoverInstallation(home, packageDir)).toBeUndefined()
    expect(await checkPluginUpdate({ dshHome: home, packageDir, fetchLatest: async () => '2.0.0' })).toMatchObject({ state: 'unavailable', canUpdate: false })
  })
})

describe('plugin update execution', () => {
  it('uses fixed public DSH CLI arguments for the discovered profile', async () => {
    const { home, packageDir } = await fixture('1.0.0')
    const profileDir = await profile(home, 'desktop', '^1.0.0', packageDir)
    const spawn = vi.fn(() => handle()) as unknown as SubprocessRuntime['spawn']
    const status = await updatePlugin({
      dshHome: home,
      packageDir,
      fetchLatest: async () => '1.1.0',
      resolveExecutable: async () => 'C:/bin/dsh.cmd',
      spawn,
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['C:/bin/dsh.cmd', 'plugin', '--profile', 'desktop', 'update', PLUGIN_PACKAGE_NAME],
      cwd: profileDir,
      env: {},
    }))
    expect(status).toMatchObject({ state: 'current', restartRequired: true })
  })

  it('refuses to update linked installations', async () => {
    const { home, packageDir } = await fixture()
    await profile(home, 'desktop', `link:${packageDir}`, packageDir, true)
    await expect(updatePlugin({ dshHome: home, packageDir, fetchLatest: async () => '2.0.0' })).rejects.toThrow('unavailable')
  })

  it('redacts credential-shaped update failure output', async () => {
    const { home, packageDir } = await fixture()
    await profile(home, 'desktop', '^1.0.0', packageDir)
    const spawn = (() => handle(1, 'Authorization: Bearer secret-value')) as SubprocessRuntime['spawn']
    await expect(updatePlugin({
      dshHome: home,
      packageDir,
      fetchLatest: async () => '2.0.0',
      resolveExecutable: async () => 'dsh',
      spawn,
    })).rejects.not.toThrow('secret-value')
  })
})

describe('plugin update Web routes', () => {
  it('enforces the route method and trusted same-origin request boundary', async () => {
    const { home, packageDir } = await fixture()
    await profile(home, 'desktop', `link:${packageDir}`, packageDir, true)
    const ctx = routeContext()
    const runtime = {
      resolveExecutable: vi.fn(),
      spawn: vi.fn(),
    } as unknown as Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
    registerClaudeUpdateRoutes(ctx, runtime, { dshHome: home, packageDir })
    const check = ctx.routes.get('/plugins/dsh-claude/update/check')!

    const wrongMethod = response()
    await check(request('POST', { host: 'localhost:56454' }), wrongMethod)
    expect(wrongMethod.statusCode).toBe(405)

    const forbidden = response()
    await check(request('GET', { host: 'attacker.test', origin: 'https://attacker.test' }), forbidden)
    expect(forbidden.statusCode).toBe(403)

    const allowed = response()
    await check(request('GET', { host: 'localhost:56454' }), allowed)
    expect(allowed.statusCode).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ source: 'link', canUpdate: false })
  })
})

describe('update response validation', () => {
  it('accepts complete bounded statuses and rejects incomplete values', () => {
    expect(isPluginUpdateStatus({ currentVersion: '1.0.0', source: 'registry', state: 'current', canUpdate: false, restartRequired: false })).toBe(true)
    expect(isPluginUpdateStatus({ currentVersion: '1.0.0', source: 'registry', state: 'current' })).toBe(false)
    expect(isPluginUpdateStatus({ currentVersion: '1.0.0', source: 'attacker', state: 'current', canUpdate: false, restartRequired: false })).toBe(false)
  })
})
