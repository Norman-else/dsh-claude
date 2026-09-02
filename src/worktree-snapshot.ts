/** Working-tree snapshots taken and restored with git's own plumbing.
 *
 *  A rewind that only truncates Claude's transcript leaves the files Claude
 *  wrote on disk, so the next turn resumes against a checkout the model no
 *  longer remembers writing. Git already stores trees: a throwaway index turns
 *  the working tree into one tree object without touching HEAD, the real
 *  index, or the checkout, and a restore reads that tree back.
 *
 *  Ignored files stay outside the snapshot in both directions. `git add -A`
 *  honours `.gitignore`, so build output and `node_modules` are neither
 *  captured nor removed.
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_OUTPUT_BYTES = 64 * 1024
/** `add -A` walks the whole checkout; a large repository needs more than the
 *  status probes' five seconds, and this sits in front of every turn. */
const GIT_TIMEOUT_MS = 30_000
const OBJECT_NAME = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u

type SnapshotRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
}

async function collect(handle: SubprocessHandle): Promise<CommandResult> {
  const outcome = await handle.done
  return { exitCode: outcome.exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '' }
}

async function run(
  runtime: SnapshotRuntime,
  git: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  return collect(runtime.spawn({
    argv: [git, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_OUTPUT_BYTES },
    },
    graceMs: 1_000,
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    env,
  }))
}

/** Capture the working tree as a git tree object.
 *
 *  Undefined whenever git cannot answer -- no git, not a repository, a locked
 *  or broken checkout. Snapshots are advisory: a turn without one simply
 *  cannot offer a file rewind, and must never fail for it.
 *
 *  ponytail: the tree is unreachable from any ref, so `git gc --prune` will
 *  eventually collect it. Two weeks is git's default grace period and a rewind
 *  happens minutes after the turn it undoes; anchor it to a real ref only if
 *  snapshots ever need to outlive a gc.
 */
export async function captureWorktreeTree(runtime: SnapshotRuntime, cwd: string): Promise<string | undefined> {
  let git: string
  try {
    git = await runtime.resolveExecutable('git')
  } catch {
    return undefined
  }
  const indexFile = join(tmpdir(), `dsh-claude-index-${process.pid}-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    // Seeding from HEAD leaves `add -A` only the differences to record. An
    // unborn branch has no HEAD, and starting from the empty index is right.
    await run(runtime, git, ['read-tree', 'HEAD'], cwd, env)
    const staged = await run(runtime, git, ['add', '-A'], cwd, env)
    if (staged.exitCode !== 0) return undefined
    const written = await run(runtime, git, ['write-tree'], cwd, env)
    const tree = written.stdout.trim()
    return written.exitCode === 0 && OBJECT_NAME.test(tree) ? tree : undefined
  } catch {
    return undefined
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined)
  }
}

/** Put a captured tree back over the working tree, reporting whether it landed.
 *
 *  Files the tree holds are rewritten, and files created after the snapshot are
 *  removed. Nothing outside the snapshot's own scope is touched: ignored files
 *  survive, because `clean` runs without `-x`.
 */
export async function restoreWorktreeTree(runtime: SnapshotRuntime, cwd: string, tree: string): Promise<boolean> {
  if (!OBJECT_NAME.test(tree)) return false
  let git: string
  try {
    git = await runtime.resolveExecutable('git')
  } catch {
    return false
  }
  try {
    // A tree a gc has already collected must fail here rather than halfway
    // through, with the checkout reset to nothing.
    const kind = await run(runtime, git, ['cat-file', '-t', tree], cwd)
    if (kind.exitCode !== 0 || kind.stdout.trim() !== 'tree') return false
    const read = await run(runtime, git, ['read-tree', '--reset', '-u', tree], cwd)
    if (read.exitCode !== 0) return false
    // Everything the snapshot held now sits in the index, so this removes
    // exactly what was created after it -- no more.
    await run(runtime, git, ['clean', '-fd'], cwd)
    // The snapshot flattened staged, unstaged, and untracked work into one
    // tree. Putting the index back on HEAD makes the restored files read as
    // the ordinary unstaged edits they were, at the cost of forgetting which
    // of them had been staged. An unborn branch has no HEAD and keeps the
    // flattened index; there is nothing else to reset to.
    await run(runtime, git, ['reset', '--mixed', 'HEAD'], cwd)
    return true
  } catch {
    return false
  }
}
