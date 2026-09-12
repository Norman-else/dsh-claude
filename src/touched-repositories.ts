/** Which other repositories a session has written into.
 *
 *  A session is pinned to one checkout, but Claude writes wherever it is
 *  pointed: a monorepo sibling, a dependency checked out next door. Those
 *  edits never showed up anywhere -- no diff, no pull request -- because every
 *  repository read keyed off the session's own cwd. The file tools' arguments
 *  are already on the activity log, so the extra roots are derived from there
 *  rather than tracked as new state. */
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, sep } from 'node:path'
import type { ClaudeActivityEvent } from './events.ts'
import type { RepositoryStatus } from './repository-status.ts'

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** The activity detail is a redacted JSON string that may be cut short, so
 *  these match one key each rather than parsing the document. */
const PATH_KEY = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/u
const COMMAND_KEY = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/u
/** An absolute path token in shell text: not the tail of a URL, a relative
 *  path, a `$VAR` or a `NAME=` assignment, and not reaching into quotes or
 *  shell punctuation. */
const PATH_TOKEN = String.raw`\/[\w.@+~-]+(?:\/[\w.@+~-]+)*`
/** Where a command goes to work or writes: the shell forms Claude actually
 *  uses under full access. Reading a path (grep, cat, ls) is not touching it. */
const WRITE_CONTEXTS: readonly RegExp[] = [
  // Going there: every relative path that follows is inside.
  new RegExp(String.raw`(?:^|[;&|(]\s*)(?:cd|pushd)\s+(${PATH_TOKEN})`, 'gmu'),
  new RegExp(String.raw`\bgit\s+-C\s+(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\bgit\s+worktree\s+add\s+(?:-\S+\s+)*(${PATH_TOKEN})`, 'gu'),
  // Writing there.
  new RegExp(String.raw`>{1,2}\s*(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\btee\s+(?:-\S+\s+)*(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\bmkdir\s+(?:-\S+\s+)*(${PATH_TOKEN})`, 'gu'),
  // Lazy over the arguments, so the first absolute path is the file, not
  // whatever path a later command on the same line happens to end with.
  new RegExp(String.raw`\bsed\s+-i\S*\s+(?:(?:'[^']*'|"[^"]*"|\S+)\s+)+?(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\b(?:cp|mv|install)\s+(?:\S+\s+)+?(${PATH_TOKEN})`, 'gu'),
  // A Python heredoc opening a file for writing.
  new RegExp(String.raw`\bopen\(\s*['"](${PATH_TOKEN})['"]\s*,\s*['"][wa]`, 'gu'),
]
/** A pathological command (a generated file list) must not turn into a
 *  hundred git probes. */
const MAX_PATHS_PER_COMMAND = 50
const PULL_REQUEST_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})(?![\d])/gu
const MAX_PULL_REQUESTS = 12

function unescaped(escaped: string): string | undefined {
  try {
    return JSON.parse(`"${escaped}"`) as string
  } catch {
    // An escape sequence split by the cap; the text is unreadable.
    return undefined
  }
}

/** Absolute paths Claude worked in or wrote to, first-seen order: the file
 *  tools' own argument, plus the paths a Bash command changes into, sets a
 *  worktree up at, or writes -- under full access Claude edits through
 *  heredocs and sed. Paths outside any repository are dropped downstream. */
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
      const found: { index: number; path: string }[] = []
      for (const context of WRITE_CONTEXTS) {
        for (const match of command.matchAll(context)) {
          const path = match[1]
          if (path !== undefined && !path.startsWith('/dev/')) found.push({ index: match.index + match[0].length - path.length, path })
        }
      }
      // In the order the command names them, whichever form named them.
      found.sort((left, right) => left.index - right.index)
      for (const { path } of found.slice(0, MAX_PATHS_PER_COMMAND)) paths.add(path)
    }
  }
  return [...paths]
}

export interface TouchedPullRequest {
  /** `owner/name` */
  readonly repository: string
  readonly number: number
}

const PR_CREATE = /\bgh\s+pr\s+create\b/u
/** A file a command writes (redirect, tee): where a script lands. */
const WRITTEN_FILE = new RegExp(String.raw`(?:>{1,2}\s*|\btee\s+(?:-\S+\s+)*)(${PATH_TOKEN}|[\w.@+~-]+(?:\/[\w.@+~-]+)*)`, 'gu')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** The pull requests the session opened: the URL `gh pr create` printed,
 *  read off that call's own result. Other than the session repository's,
 *  once each in first-seen order. A URL merely read, quoted or mentioned
 *  (a fixture, a summary, a `gh pr view`) is not one the session made.
 *  A script the session wrote with `gh pr create` inside and then ran by
 *  name -- once per repository, the way a fan-out gets done -- counts the
 *  same: the URLs come out of the runs, not of the write.
 *  A checkout that has since moved back to its base branch no longer knows
 *  about its pull request; the log still does. */
export function touchedPullRequests(activities: readonly ClaudeActivityEvent[], ownRepository: string | undefined): readonly TouchedPullRequest[] {
  const found = new Map<string, TouchedPullRequest>()
  const own = ownRepository?.toLowerCase()
  const creating = new Set<string>()
  /** Basenames of scripts written with `gh pr create` inside, as patterns. */
  const scripts: RegExp[] = []
  for (const activity of activities) {
    if (activity.toolUseId === undefined) continue
    if (activity.kind === 'tool-call' || (activity.kind === 'subagent' && activity.toolName !== undefined)) {
      if (activity.toolName !== 'Bash' || activity.detail === undefined) continue
      const escaped = COMMAND_KEY.exec(activity.detail)?.[1]
      const command = escaped === undefined ? undefined : unescaped(escaped)
      if (command === undefined) continue
      if (PR_CREATE.test(command)) {
        creating.add(activity.toolUseId)
        for (const match of command.matchAll(WRITTEN_FILE)) {
          const name = match[1]?.split('/').at(-1)
          if (name !== undefined && name.length > 0) scripts.push(new RegExp(String.raw`(?:^|[\s/])${escapeRegExp(name)}(?=$|\s)`, 'mu'))
        }
      } else if (scripts.some(script => script.test(command))) {
        creating.add(activity.toolUseId)
      }
      continue
    }
    if (activity.detail === undefined || !creating.has(activity.toolUseId)) continue
    for (const match of activity.detail.matchAll(PULL_REQUEST_URL)) {
      const repository = match[1]?.toLowerCase()
      const number = Number(match[2])
      if (repository === undefined || repository === own || !Number.isSafeInteger(number) || number <= 0) continue
      const key = `${repository}#${number}`
      if (found.has(key)) continue
      found.set(key, { repository, number })
      if (found.size >= MAX_PULL_REQUESTS) return [...found.values()]
    }
  }
  return [...found.values()]
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
    // A repository the session checkout sits inside (a dotfiles home
    // directory, a monorepo the checkout is a nested clone in) is not
    // somewhere the session went; every path under it would drag it in.
    if (sessionRoot.startsWith(root.endsWith(sep) ? root : root + sep)) continue
    roots.push(root)
    if (roots.length >= max) break
  }
  return roots
}

/** Whether a linked checkout still has anything to show. A cleaned-up
 *  worktree is gone, and a checkout cleaned up in place is back on base with
 *  nothing pending -- either way its bar comes down. A checkout with an open
 *  or merged pull request, or unpushed commits, stays. A clean branch with no
 *  upstream is what a tool checkout looks like and is no evidence on its own. */
export function linkedRepositoryShown(status: RepositoryStatus): boolean {
  if (status.status !== 'ready') return false
  return status.dirty === true || (status.ahead ?? 0) > 0 || status.pullRequest !== undefined
}
