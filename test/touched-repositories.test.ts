import { describe, expect, it } from 'vitest'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { linkedRepositoryShown, touchedFilePaths, touchedPullRequests, touchedRepositoryRoots } from '../src/touched-repositories.ts'

function call(toolName: string, input: unknown, kind: ClaudeActivityEvent['kind'] = 'tool-call'): ClaudeActivityEvent {
  return { turn: 1, step: 1, ordinal: 1, kind, toolName, detail: JSON.stringify(input) }
}

describe('touched file paths', () => {
  it('reads absolute paths off Edit, Write and NotebookEdit calls, once each, in order', () => {
    expect(touchedFilePaths([
      call('Edit', { file_path: '/b/src/a.ts', old_string: 'x', new_string: 'y' }),
      call('Write', { file_path: '/b/src/b.ts', content: 'z' }),
      call('Edit', { file_path: '/b/src/a.ts', old_string: 'y', new_string: 'x' }),
      call('NotebookEdit', { notebook_path: '/c/n.ipynb', new_source: '' }),
      call('Edit', { file_path: 'relative.ts', old_string: '', new_string: '' }),
      call('Read', { file_path: '/d/read-only.ts' }),
      call('Edit', { file_path: '/e/sub.ts', old_string: '', new_string: '' }, 'subagent'),
      { turn: 1, step: 1, ordinal: 2, kind: 'tool-result', detail: '{"file_path":"/f/result.ts"}' },
    ])).toEqual(['/b/src/a.ts', '/b/src/b.ts', '/c/n.ipynb', '/e/sub.ts'])
  })

  it('reads the paths a Bash command works in or writes to, which is how a full-access session edits', () => {
    const command = [
      'PATH=/opt/homebrew/bin:$PATH grep -rn "export" /Users/n/read-only/src | head',
      'git worktree add /Users/n/repo-b/.claude/worktrees/T-1 -b T-1 && cd /Users/n/repo-b/.claude/worktrees/T-1',
      'cat > /Users/n/repo-b/.claude/worktrees/T-1/src/a.ts <<\'EOF\'',
      'export const url = "https://github.com/org/repo/pull/1"',
      'EOF',
      'git -C /Users/n/repo-c status; tee -a /Users/n/repo-d/log.txt; mkdir -p /Users/n/repo-e/dir',
      'sed -i \'\' "s#x#y#" /Users/n/repo-f/x.ts 2>/dev/null; cp a.ts /Users/n/repo-g/a.ts; echo $HOME/skip ~/skip-too',
      "python3 - <<'PY'",
      "open('/Users/n/repo-h/y.py', 'w').write('x'); open('/Users/n/read-only/z.py').read()",
      'PY',
    ].join('\n')
    expect(touchedFilePaths([call('Bash', { command, description: 'Set up the frontend worktree' })])).toEqual([
      '/Users/n/repo-b/.claude/worktrees/T-1',
      '/Users/n/repo-b/.claude/worktrees/T-1/src/a.ts',
      '/Users/n/repo-c',
      '/Users/n/repo-d/log.txt',
      '/Users/n/repo-e/dir',
      '/Users/n/repo-f/x.ts',
      '/Users/n/repo-g/a.ts',
      '/Users/n/repo-h/y.py',
    ])
  })

  it('survives a detail cut short by the redaction cap and unescapes JSON', () => {
    const cut = JSON.stringify({ file_path: '/repo/"quoted"/x.ts', content: 'a'.repeat(5_000) }).slice(0, 4_000)
    expect(touchedFilePaths([{ turn: 1, step: 1, ordinal: 1, kind: 'tool-call', toolName: 'Write', detail: cut }])).toEqual(['/repo/"quoted"/x.ts'])
    expect(touchedFilePaths([{ turn: 1, step: 1, ordinal: 1, kind: 'tool-call', toolName: 'Write', detail: '{"content":"…","file_pa' }])).toEqual([])
  })
})

describe('touched repository roots', () => {
  it('resolves each path to its repository, drops the session root and non-repositories, and caps the list', async () => {
    const roots: Record<string, string | undefined> = {
      '/a/src': '/a', '/b/src': '/b', '/b/lib': '/b', '/tmp': undefined, '/c': '/c', '/d': '/d',
    }
    const asked: string[] = []
    const rootOf = async (directory: string): Promise<string | undefined> => {
      asked.push(directory)
      return roots[directory]
    }
    await expect(touchedRepositoryRoots(
      ['/a/src/x.ts', '/b/src/x.ts', '/b/lib/y.ts', '/b/src/z.ts', '/tmp/t.txt', '/c/c.ts', '/d/d.ts'],
      '/a',
      rootOf,
      2,
      async () => false,
    )).resolves.toEqual(['/b', '/c'])
    // One probe per distinct directory, and none once the cap is reached.
    expect(asked).toEqual(['/a/src', '/b/src', '/b/lib', '/tmp', '/c'])
  })

  it('ignores a repository that contains the session checkout, such as a dotfiles home directory', async () => {
    const rootOf = async (directory: string): Promise<string | undefined> => (
      directory.startsWith('/home/n/repo-a') ? '/home/n/repo-a' : directory.startsWith('/home/n') ? '/home/n' : undefined
    )
    await expect(touchedRepositoryRoots(['/home/n/.zshrc', '/home/n/notes/x.md'], '/home/n/repo-a', rootOf, 8, async () => false)).resolves.toEqual([])
    // A repository nested inside the session checkout is still its own.
    const nested = async (directory: string): Promise<string | undefined> => (directory.startsWith('/home/n/repo-a/vendor/lib') ? '/home/n/repo-a/vendor/lib' : '/home/n/repo-a')
    await expect(touchedRepositoryRoots(['/home/n/repo-a/vendor/lib/x.ts'], '/home/n/repo-a', nested, 8, async () => false)).resolves.toEqual(['/home/n/repo-a/vendor/lib'])
  })

  it('probes a directory path itself, so a checkout named whole in a command resolves to its own root', async () => {
    const asked: string[] = []
    const rootOf = async (directory: string): Promise<string | undefined> => {
      asked.push(directory)
      return directory.startsWith('/b') ? '/b' : undefined
    }
    await expect(touchedRepositoryRoots(['/b', '/b/src/x.ts'], '/a', rootOf, 8, async path => path === '/b')).resolves.toEqual(['/b'])
    expect(asked).toEqual(['/b', '/b/src'])
  })
})

describe('linked repository visibility', () => {
  const ready = { status: 'ready' as const, cwd: '/b', root: '/b', branch: 'fix', detached: false, worktree: false, dirty: false, upstream: true, ahead: 0 }
  const pullRequest = { number: 1, title: 't', url: 'https://github.com/o/r/pull/1', state: 'merged' as const, draft: false, review: 'none' as const, checks: 'none' as const }

  it('shows a checkout while there is something to see and hides it once it is back to nothing', () => {
    expect(linkedRepositoryShown({ ...ready, dirty: true })).toBe(true)
    expect(linkedRepositoryShown({ ...ready, ahead: 2 })).toBe(true)
    expect(linkedRepositoryShown({ ...ready, pullRequest })).toBe(true)
    // A clean local-only branch is what a tool checkout (Homebrew's `stable`)
    // looks like; on its own it is no sign the session did anything there.
    expect(linkedRepositoryShown({ ...ready, upstream: false })).toBe(false)
    // Cleaned up in place: back on base, clean, nothing to push, no pull request.
    expect(linkedRepositoryShown(ready)).toBe(false)
    // Cleaned up as a worktree: the directory is gone.
    expect(linkedRepositoryShown({ status: 'unavailable', cwd: '/b' })).toBe(false)
    expect(linkedRepositoryShown({ status: 'not-repository', cwd: '/b' })).toBe(false)
  })
})

describe('touched pull requests', () => {
  it('collects only the pull requests the session opened through gh, other than the session repository, once each', () => {
    const create = (id: string, command: string): ClaudeActivityEvent => ({ turn: 1, step: 1, ordinal: 0, kind: 'tool-call', toolUseId: id, toolName: 'Bash', detail: JSON.stringify({ command }) })
    const result = (id: string, detail: string): ClaudeActivityEvent => ({ turn: 1, step: 1, ordinal: 1, kind: 'tool-result', toolUseId: id, detail })
    const activities: ClaudeActivityEvent[] = [
      create('c1', 'cd /Users/n/repo-b && gh pr create --title x --body y'),
      result('c1', 'Creating pull request for PSOS-1 into master in org/repo-b\n\nhttps://github.com/org/repo-b/pull/2086\n'),
      create('c2', 'gh pr create --repo org/own --title z'),
      result('c2', 'https://github.com/org/own/pull/5171\n'),
      create('c3', 'gh pr create --title again'),
      result('c3', 'https://github.com/Org/Repo-B/pull/2086\n'),
      // Read, quoted or merely mentioned: not opened by this session.
      create('c4', 'sed -n 1,40p test/fixture.ts'),
      result('c4', "url: 'https://github.com/org/other/pull/12'"),
      { turn: 1, step: 2, ordinal: 0, kind: 'text', text: 'see https://github.com/org/other/pull/7' },
      create('c5', 'gh pr view https://github.com/org/other/pull/9'),
      result('c5', 'https://github.com/org/other/pull/9'),
    ]
    expect(touchedPullRequests(activities, 'org/own')).toEqual([{ repository: 'org/repo-b', number: 2086 }])
    expect(touchedPullRequests(activities, undefined)).toEqual([
      { repository: 'org/repo-b', number: 2086 },
      { repository: 'org/own', number: 5171 },
    ])
  })
})
