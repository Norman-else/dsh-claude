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
 *  path, a `$VAR` or a `NAME=` assignment, and not reaching into quotes or
 *  shell punctuation. */
const PATH_TOKEN = String.raw`\/[\w.@+~-]+(?:\/[\w.@+~-]+)*`
/** Going there: every relative path that follows is inside. Counted only when
 *  something is changed while there (MUTATES, up to the next one of these) --
 *  `cd repo && git grep` is reading, and `cd repo && git worktree add /tmp/w;
 *  cd /tmp/w && git commit` changed the worktree, not the checkout. */
const GO_CONTEXTS: readonly RegExp[] = [
  new RegExp(String.raw`(?:^|[;&|(]\s*)(?:cd|pushd)\s+(${PATH_TOKEN})`, 'gmu'),
  new RegExp(String.raw`\bgit\s+-C\s+(${PATH_TOKEN})`, 'gu'),
]
/** Anything in a command that writes where it stands: a redirect to a
 *  relative file, an in-place edit, a file operation,
 *  a git command that moves the checkout or its history. */
const MUTATES = /(?<![\d&=-])>{1,2}[ \t]*(?=[\w.])|\btee\s|\bsed\s+-i|\bperl\s+-\S*i|\b(?:mkdir|touch|rm|cp|mv|install|patch)\s|\bopen\([^)]*['"][wa]['"]|\bgit\s+(?:-C\s+\S+\s+)?(?:add|am|apply|checkout|cherry-pick|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag)\b|\bgh\s+pr\s+create\b/u
/** Where a stretch of the command ends: any change of directory, relative too. */
const LEAVES = /(?:^|[;&|(]\s*)(?:cd|pushd|popd)\b/gmu
/** Double-quoted text and heredoc bodies are arguments (a PR body, a note,
 *  a grep pattern), not shell. */
const QUOTED = /"(?:[^"\\]|\\.)*"|<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/gu
/** Where a command goes to work or writes: the shell forms Claude actually
 *  uses under full access. Reading a path (grep, cat, ls) is not touching it. */
const WRITE_CONTEXTS: readonly RegExp[] = [
  new RegExp(String.raw`\bgit\s+worktree\s+add\s+(?:-\S+\s+)*(${PATH_TOKEN})`, 'gu'),
  // Writing there.
  new RegExp(String.raw`>{1,2}\s*(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\btee\s+(?:-\S+\s+)*(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\bmkdir\s+(?:-\S+\s+)*(${PATH_TOKEN})`, 'gu'),
  // Lazy over the arguments, so the first absolute path is the file, not
  // whatever path a later command on the same line happens to end with; and
  // not past the command's end, or `sed -i … a.md` would take the next
  // line's `cd /elsewhere` for its file.
  new RegExp(String.raw`\bsed[ \t]+-i[^\s;&|]*[ \t]+(?:(?:'[^'\n]*'|"[^"\n]*"|[^\s;&|]+)[ \t]+)+?(${PATH_TOKEN})`, 'gu'),
  new RegExp(String.raw`\b(?:cp|mv|install)[ \t]+(?:[^\s;&|]+[ \t]+)+?(${PATH_TOKEN})`, 'gu'),
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
      // Same length, so the offsets below still line up with the command.
      const shell = command.replace(QUOTED, text => ' '.repeat(text.length))
      const found: { index: number; path: string }[] = []
      const pathOf = (match: RegExpMatchArray) => ({ index: (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0), path: match[1] ?? '' })
      const gone = GO_CONTEXTS.flatMap(context => [...command.matchAll(context)].map(pathOf)).sort((left, right) => left.index - right.index)
      const leaves = [...shell.matchAll(LEAVES)].map(match => match.index + match[0].length)
      for (const go of gone) {
        const from = go.index + go.path.length
        const stretch = shell.slice(from, leaves.find(index => index > from))
        if (MUTATES.test(stretch)) found.push(go)
      }
      for (const context of WRITE_CONTEXTS) {
        for (const match of command.matchAll(context)) {
          const written = pathOf(match)
          if (written.path !== '' && !written.path.startsWith('/dev/')) found.push(written)
        }
      }
      // In the order the command names them, whichever form named them.
      found.sort((left, right) => left.index - right.index)
      for (const { path } of found.slice(0, MAX_PATHS_PER_COMMAND)) paths.add(path)
    }
  }
  return [...paths]
}

/** Every absolute path a Bash command changed into, written there or not.
 *  Not a linked checkout on its own, but where the user's clones live: a
 *  pull request whose worktree is gone is still mergeable through one. */
export function visitedPaths(activities: readonly ClaudeActivityEvent[]): readonly string[] {
  const paths = new Set<string>()
  for (const activity of activities) {
    if ((activity.kind !== 'tool-call' && activity.kind !== 'subagent') || activity.toolName !== 'Bash' || activity.detail === undefined) continue
    const escaped = COMMAND_KEY.exec(activity.detail)?.[1]
    const command = escaped === undefined ? undefined : unescaped(escaped)
    if (command === undefined) continue
    for (const context of GO_CONTEXTS) {
      for (const match of command.matchAll(context)) if (match[1] !== undefined) paths.add(match[1])
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
/** Whether `child` lies strictly under `parent`. Compared with one separator:
 *  on Windows git prints forward slashes where Node resolves to backslashes,
 *  and a root can arrive in either form. */
function isInside(child: string, parent: string): boolean {
  const slashed = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/u, '')
  return slashed(child).startsWith(`${slashed(parent)}/`)
}

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
    if (isInside(sessionRoot, root)) continue
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
