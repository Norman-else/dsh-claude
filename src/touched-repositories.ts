/** Which other repositories a session has written into.
 *
 *  A session is pinned to one checkout, but Claude writes wherever it is
 *  pointed: a monorepo sibling, a dependency checked out next door. Those
 *  edits never showed up anywhere -- no diff, no pull request -- because every
 *  repository read keyed off the session's own cwd. The file tools' arguments
 *  are already on the activity log, so the extra roots are derived from there
 *  rather than tracked as new state. */
import { dirname, isAbsolute } from 'node:path'
import type { ClaudeActivityEvent } from './events.ts'
import type { RepositoryStatus } from './repository-status.ts'

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** The activity detail is a redacted JSON string that may be cut short, so
 *  this matches the one key rather than parsing the document. */
const PATH_KEY = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/u

/** Absolute paths Claude wrote through its file tools, first-seen order. */
export function touchedFilePaths(activities: readonly ClaudeActivityEvent[]): readonly string[] {
  const paths = new Set<string>()
  for (const activity of activities) {
    if ((activity.kind !== 'tool-call' && activity.kind !== 'subagent')
      || activity.toolName === undefined || !FILE_TOOLS.has(activity.toolName)
      || activity.detail === undefined) continue
    const escaped = PATH_KEY.exec(activity.detail)?.[1]
    if (escaped === undefined) continue
    try {
      const path = JSON.parse(`"${escaped}"`) as string
      if (isAbsolute(path)) paths.add(path)
    } catch {
      // An escape sequence split by the cap; the path is unreadable.
    }
  }
  return [...paths]
}

/** Repository roots behind the touched paths, minus the session's own, in
 *  first-seen order. `rootOf` answers undefined outside any repository. */
export async function touchedRepositoryRoots(
  paths: readonly string[],
  sessionRoot: string,
  rootOf: (directory: string) => Promise<string | undefined>,
  max: number,
): Promise<readonly string[]> {
  const roots: string[] = []
  const directories = new Set(paths.map(path => dirname(path)))
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
