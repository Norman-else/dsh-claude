/** Real git, real files.
 *
 *  What is hard here is not the argv -- it is whether git accepts these POSIX
 *  patterns and picks the line a reader expects. Only git can answer that, so
 *  the test diffs actual fixtures and reads the `@@` headers back. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const FIXTURES: Record<string, string> = {
  'Store.java': `class Store {

    void alpha() {
        int a = 1;
        int b = 2;
        int c = 3;
        int d = 4;
    }

    void beta() {
        int a = 1;
        int b = 2;
        int c = 3;
        int d = 4;
    }
}
`,
  'store.kt': `class Store {
    fun alpha() {
        val a = 1
        val b = 2
        val c = 3
        val d = 4
    }

    fun beta() {
        val a = 1
        val b = 2
        val c = 3
        val d = 4
    }
}
`,
  'store.py': `class Store:
    def alpha(self):
        a = 1
        b = 2
        c = 3
        d = 4

    def beta(self):
        a = 1
        b = 2
        c = 3
        d = 4
`,
  'Panel.tsx': `export function Panel() {
  const a = 1
  const b = 2
  const c = 3
  const d = 4
  return null
}

class Store {
  add(item: string): void {
    const a = 1
    const b = 2
    const e = 5
    const f = 6
    const c = 3
    const d = 4
  }
}
`,
  'card.css': `.card {
  color: red;
  margin: 0;
  padding: 1px;
  border: 0;
}

.panel {
  color: blue;
  margin: 0;
  padding: 1px;
  border: 0;
}
`,
}

/** Edit the last marker in a fixture: the hunk then sits inside the second block. */
function edited(body: string): string {
  const marker = body.includes('padding: 1px') ? 'padding: 1px' : 'c = 3'
  const at = body.lastIndexOf(marker)
  return `${body.slice(0, at)}${marker === 'c = 3' ? 'c = 33' : 'padding: 2px'}${body.slice(at + marker.length)}`
}

/** The header git prints for the one hunk in `file`. */
let headerOf: (file: string) => string

describe('diff funcname drivers', () => {
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-claude-funcname-'))
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-claude-home-'))
    const git = (...args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q', '.')
    for (const [name, body] of Object.entries(FIXTURES)) await writeFile(join(root, name), body, 'utf8')
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
    for (const [name, body] of Object.entries(FIXTURES)) {
      // The last occurrence, so the hunk lands inside the second block and the
      // header has a real declaration to find above it.
      await writeFile(join(root, name), edited(body), 'utf8')
    }
    // The import is deferred so DSH_HOME is already set when the module memoizes.
    const { diffFuncnameArgs } = await import('../src/diff-funcname.ts')
    const args = await diffFuncnameArgs()
    expect(args).toHaveLength(4)
    headerOf = (file: string) => {
      const patch = git(...args, 'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', file)
      return patch.split('\n').find(line => line.startsWith('@@'))?.replace(/^@@[^@]*@@ ?/u, '') ?? ''
    }
  })

  it.each([
    ['Store.java', 'void alpha() {'],
    ['store.kt', 'fun alpha() {'],
    ['store.py', 'def alpha(self):'],
    ['Panel.tsx', 'add(item: string): void {'],
    ['card.css', '.card {'],
  ])('names the enclosing block in %s', (file, expected) => {
    expect(headerOf(file)).toBe(expected)
  })
})
