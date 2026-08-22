import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
