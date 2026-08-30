import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as buildConfigModule from '../tsdown.config.ts'

const root = join(import.meta.dirname, '..')

describe('published package contract', () => {
  it('ships each system preset under its preset ID directory', async () => {
    const presetRoot = join(root, 'preset')
    expect(await readdir(presetRoot)).toEqual(['claude'])
    await expect(readFile(join(presetRoot, 'claude', 'agent.cordis.yml'), 'utf8')).resolves.toContain("name: '@norman-else/dsh-claude/preset-route'")
    await expect(readFile(join(presetRoot, 'claude', 'preset.yml'), 'utf8')).resolves.toContain('name: Claude')
  })

  it('contains no legacy claude-code-cli runtime or migration identifier', async () => {
    const paths = [
      'src/constants.ts',
      'src/index.ts',
      'src/adapter.ts',
      'src/client/conversation-sidecar.ts',
      'src/preset-installer.ts',
      'test/adapter.test.ts',
      'test/preset-installer.test.ts',
    ]
    const contents = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))
    expect(contents.join('\n')).not.toContain('claude-code-cli')
  })

  it('declares the public DSH attachment service contract on the Desktop development graph', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const [host, workspace] = await Promise.all([
      readFile(join(root, 'src/index.ts'), 'utf8'),
      readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    ])
    const dshDevelopmentVersions = Object.entries(packageJson.devDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, version]) => version)
    expect(packageJson.peerDependencies['@deepseek-ai/dsh-attachment']).toBe('*')
    expect(dshDevelopmentVersions.length).toBeGreaterThan(0)
    expect(new Set(dshDevelopmentVersions)).toEqual(new Set(['0.1.1-rc.2']))
    expect(workspace).toContain("'@deepseek-ai/dsh-*': 0.1.1-rc.2")
    expect(host).toContain("'attachments'")
    expect(host).toContain('ctx.attachments')
  })

  it('declares every required client service provider in the boot graph', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dsh: { client: { inject: string[] } }
    }
    const client = await readFile(join(root, 'src/client/index.tsx'), 'utf8')

    expect(client).toContain("'connection'")
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-client-connection')
    expect(client).toMatch(/export const inject = \[[^\]]*'uiConversation'/u)
    expect(client).toContain("ctx.get('uiConversation')")
    expect(client).not.toContain("['conversationEvents']")
  })

  it('uses the split Desktop client controllers instead of the removed runtime bundle', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dsh: { client: { inject: string[] } }
    }

    expect(packageJson.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    expect(packageJson.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(packageJson.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-slots')
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-api-session-controller')
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-api-workspace-controller')
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-api-remotes')
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-session')
  })

  // dsh.client.inject is the client module graph's readiness declaration: every
  // package owning a service this plugin injects, or a Slot it registers into,
  // must be listed or the entry can apply before that owner mounts. Desktop's
  // own client-ui-deliverables — the other 'conversation.chat.turnTail'
  // occupant — declares exactly this pair alongside the conversation seats.
  it('declares the owners of the chat Slots and the slots service', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dsh: { client: { inject: string[] } }
    }
    const client = await readFile(join(root, 'src/client/index.tsx'), 'utf8')

    expect(client).toContain("slots.inject('conversation.chat.node'")
    expect(client).toContain("slots.inject('conversation.chat.turnTail'")
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-chat')
    expect(packageJson.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-renderer')
  })

  // Renderer failures reach nobody on their own: the Host catches a crashed
  // Slot entry, drops it, and still reports a healthy boot. Losing this wiring
  // would return the plugin to failing invisibly, which is what made every
  // Desktop 2.0 breakage here cost hours to find.
  it('reports renderer failures and boot drift to the Host log', async () => {
    const [client, host] = await Promise.all([
      readFile(join(root, 'src/client/index.tsx'), 'utf8'),
      readFile(join(root, 'src/index.ts'), 'utf8'),
    ])

    expect(client).toContain('createClaudeDiagnosticsReporter()')
    expect(client).toContain('claudeBootCheckFindings(')
    // Not just the diff overlay: onEntryError has to report before it recovers.
    expect(client).toMatch(/onEntryError\(\(key, entry, error\)/u)
    expect(client).toContain("diagnostics.report('slot-entry-crashed'")
    expect(host).toContain('registerClaudeClientDiagnosticsRoute(webCtx)')
  })

  it('uses the npm package name in the DSH host and browser bundles', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string }
    const [patch, buildConfig] = await Promise.all([
      readFile(join(root, 'cordis.patch.yml'), 'utf8'),
      readFile(join(root, 'tsdown.config.ts'), 'utf8'),
    ])

    expect(patch).toContain(`name: '${packageJson.name}'`)
    expect(patch).not.toMatch(/^\s+name: (?:dsh-claude|@\S+)\s*$/mu)
    expect(buildConfig).toContain(`id: \"${packageJson.name}\"`)
    expect(buildConfig).not.toContain('id: \"dsh-claude\"')
  })

  it('converts aliased ESM imports into valid ModuleLoader require bindings', () => {
    const wrapDshClientModule = Reflect.get(buildConfigModule, 'wrapDshClientModule') as ((code: string) => string) | undefined
    const source = [
      'import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";',
      'const name = "dsh-claude-client";',
      'export { name };',
    ].join('\n')

    expect(wrapDshClientModule).toBeTypeOf('function')
    const wrapped = wrapDshClientModule?.(source)
    expect(wrapped).toContain('window.__ModuleLoader__.load')
    expect(wrapped).toContain('var { Fragment: Fragment$1, jsx, jsxs } = require("react/jsx-runtime");')
    expect(wrapped).not.toContain('var { Fragment as Fragment$1')
  })
})
