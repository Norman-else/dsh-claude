/** Which other repositories a session has written into.
 *
 *  A session is pinned to one checkout, but Claude writes wherever it is
 *  pointed: a monorepo sibling, a dependency checked out next door. Those
 *  edits never showed up anywhere -- no diff, no pull request -- because every
 *  repository read keyed off the session's own cwd. The file tools' arguments
 *  are already on the activity log, so the extra roots are derived from there
 *  rather than tracked as new state. */
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { ClaudeActivityEvent } from './events.ts'
import type { RepositoryStatus } from './repository-status.ts'

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** The activity detail is a redacted JSON string that may be cut short, so
 *  these match one key each rather than parsing the document. */
const PATH_KEY = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/u
const COMMAND_KEY = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/u
/** An absolute path token in shell text: not the tail of a URL, a relative
 *  path, or a `$VAR`, and not reaching into quotes or shell punctuation. */
const SHELL_PATH = /(?<![\w:/.~$])\/[\w.@+~-]+(?:\/[\w.@+~-]+)*/gu
/** A pathological command (a generated file list) must not turn into a
 *  hundred git probes. */
const MAX_PATHS_PER_COMMAND = 50

function unescaped(escaped: string): string | undefined {
  try {
    return JSON.parse(`"${escaped}"`) as string
  } catch {
    // An escape sequence split by the cap; the text is unreadable.
    return undefined
  }
}

/** Absolute paths Claude wrote to, first-seen order: the file tools' own
 *  argument, plus every absolute path named in a Bash command -- under full
 *  access Claude edits through heredocs and sed, and a worktree it sets up
 *  for another repository is only ever named on a command line. Paths that
 *  turn out not to be in a repository are dropped downstream. */
export function touchedFilePaths(activities: readonly ClaudeActivityEvent[]): readonly string[] {
  const paths = new Set<string>()
  for (const activity of activities) {
    if ((activity.kind !== 'tool-call' && activity.kind !== 'subagent')
      || activity.toolName === undefined || activity.detail === undefined) continue
    if (FILE_TOOLS.has(activity.toolName)) {
      const escaped = PATH_KEY.exec(activity.detail)?.[1]
      const path = escaped === undefined ? undefined : unescaped(escaped)
      if (path !== undefined && isAbsolute(path)) paths.add(path)
    } else if (activity.toolName === 'Bash') {
      const escaped = COMMAND_KEY.exec(activity.detail)?.[1]
      const command = escaped === undefined ? undefined : unescaped(escaped)
      if (command === undefined) continue
      let count = 0
      for (const match of command.matchAll(SHELL_PATH)) {
        if (count >= MAX_PATHS_PER_COMMAND) break
        count += 1
        paths.add(match[0])
      }
    }
  }
  return [...paths]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Repository roots behind the touched paths, minus the session's own, in
 *  first-seen order. `rootOf` answers undefined outside any repository. */
export async function touchedRepositoryRoots(
  paths: readonly string[],
  sessionRoot: string,
  rootOf: (directory: string) => Promise<string | undefined>,
  max: number,
  directory: (path: string) => Promise<boolean> = isDirectory,
): Promise<readonly string[]> {
  const roots: string[] = []
  const directories = new Set<string>()
  // A path named whole (a worktree, a repository) is probed as itself; its
  // parent is usually not a repository at all.
  for (const path of paths) directories.add(await directory(path) ? path : dirname(path))
  for (const directory of directories) {
    const root = await rootOf(directory)
    if (root === undefined || root === sessionRoot || roots.includes(root)) continue
    roots.push(root)
    if (roots.length >= max) break
  }
  return roots
}

/** Whether a linked checkout still has anything to show. A cleaned-up
 *  worktree is gone, and a checkout cleaned up in place is back on base with
 *  nothing pending -- either way its bar comes down. A clean checkout with an
 *  open or merged pull request, or unpushed work, stays. */
export function linkedRepositoryShown(status: RepositoryStatus): boolean {
  if (status.status !== 'ready') return false
  return status.dirty === true || status.upstream === false || (status.ahead ?? 0) > 0 || status.pullRequest !== undefined
}
