import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

describe('published package contract', () => {
  it('uses the npm package name in the DSH host bundle', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string }
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')

    expect(patch).toContain(`name: ${packageJson.name}`)
    expect(patch).not.toMatch(/^\s+name: dsh-claude\s*$/mu)
  })
})
