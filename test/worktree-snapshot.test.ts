/** Real git, real files.
 *
 *  A faked runtime could only assert the argv sequence, and the argv sequence
 *  is not what is hard here: whether `read-tree --reset -u` followed by
 *  `clean -fd` actually lands on the captured tree, and whether it stops short
 *  of the ignored files, is a property of git rather than of this module. */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { captureWorktreeTree, restoreWorktreeTree } from '../src/worktree-snapshot.ts'

/** The narrow slice of the DSH subprocess seam this module uses, over node's
 *  own child_process. */
function realRuntime() {
  return {
    resolveExecutable: async (name: string) => name,
    spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
      const [command, ...args] = spec.argv
      const child = nodeSpawn(command as string, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      return {
        pid: child.pid ?? -1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done: new Promise(resolve => {
          child.on('close', exitCode => { resolve({ exitCode, signal: null }) })
        }),
        terminate: () => { child.kill() },
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
    },
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn('git', args, { cwd, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => { code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`)) })
  })
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-snapshot-'))
  await git(root, 'init', '--initial-branch=main')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await git(root, 'config', 'user.name', 'Test')
  await writeFile(join(root, '.gitignore'), 'ignored/\n')
  await writeFile(join(root, 'tracked.txt'), 'committed\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'initial')
  return root
}

describe('worktree snapshots', () => {
  it('restores tracked edits and new files, and leaves ignored files alone', async () => {
    const runtime = realRuntime()
    const root = await repository()
    try {
      // The state one turn is admitted against: a committed file already
      // edited, an untracked file already written, and ignored build output.
      await writeFile(join(root, 'tracked.txt'), 'edited before the turn\n')
      await writeFile(join(root, 'untracked.txt'), 'written before the turn\n')
      await mkdir(join(root, 'ignored'), { recursive: true })
      await writeFile(join(root, 'ignored', 'build.out'), 'build output\n')

      const tree = await captureWorktreeTree(runtime, root)
      expect(tree).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u)

      // What the turn then did: rewrote both files and added a third.
      await writeFile(join(root, 'tracked.txt'), 'rewritten by the turn\n')
      await writeFile(join(root, 'untracked.txt'), 'rewritten by the turn\n')
      await writeFile(join(root, 'added.txt'), 'created by the turn\n')
      await writeFile(join(root, 'ignored', 'build.out'), 'rebuilt by the turn\n')

      expect(await restoreWorktreeTree(runtime, root, tree as string)).toBe(true)

      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('edited before the turn\n')
      expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('written before the turn\n')
      expect(existsSync(join(root, 'added.txt'))).toBe(false)
      // Ignored files are outside the snapshot in both directions: never
      // captured, so never reverted and never deleted.
      expect(await readFile(join(root, 'ignored', 'build.out'), 'utf8')).toBe('rebuilt by the turn\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('brings back a file the turn deleted', async () => {
    const runtime = realRuntime()
    const root = await repository()
    try {
      const tree = await captureWorktreeTree(runtime, root)
      await rm(join(root, 'tracked.txt'))
      expect(await restoreWorktreeTree(runtime, root, tree as string)).toBe(true)
      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('committed\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('captures nothing outside a repository and refuses an unknown tree', async () => {
    const runtime = realRuntime()
    const plain = await mkdtemp(join(tmpdir(), 'dsh-claude-plain-'))
    const root = await repository()
    try {
      expect(await captureWorktreeTree(runtime, plain)).toBeUndefined()
      // A tree a gc has already collected must be refused before the checkout
      // is reset to it.
      expect(await restoreWorktreeTree(runtime, root, '0'.repeat(40))).toBe(false)
      expect(await restoreWorktreeTree(runtime, root, 'not-an-object')).toBe(false)
      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('committed\n')
    } finally {
      await rm(plain, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})
