import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_OUTPUT_BYTES = 8 * 1024
/** Long enough for a launcher shim to fail loudly, short enough that the
 *  request returns while the IDE is still booting. On Windows and Linux the
 *  IDE binary IS the launched process, so still running past this is success. */
const SETTLE_MS = 1_500

export type EditorId = 'cursor' | 'idea'
export const EDITOR_IDS: ReadonlySet<string> = new Set<EditorId>(['cursor', 'idea'])

/** Launch commands tried in order, first success wins. macOS keeps `open -a`
 *  behind the CLI shim because both shims are opt-in installs there, while
 *  `open -a` finds the bundle wherever Toolbox or the DMG dropped it. */
const LAUNCHERS: Record<EditorId, Partial<Record<NodeJS.Platform, readonly (readonly string[])[]>>> = {
  cursor: {
    darwin: [['cursor'], ['open', '-a', 'Cursor']],
    win32: [['cursor']],
    linux: [['cursor']],
  },
  idea: {
    darwin: [['idea'], ['open', '-a', 'IntelliJ IDEA'], ['open', '-a', 'IntelliJ IDEA CE']],
    win32: [['idea'], ['idea64.exe']],
    linux: [['idea'], ['idea.sh']],
  },
}

/** cmd.exe re-interprets these, and a mis-parsed path opens the wrong project
 *  rather than failing. Refuse instead of guessing. */
const WINDOWS_UNSAFE = /["&|<>^%]/u

export class EditorOpenError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EditorOpenError'
    this.code = code
  }
}

/** Open a session's working directory in a desktop editor. */
export class EditorOpenService {
  readonly #runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  readonly #platform: NodeJS.Platform
  readonly #settleMs: number

  constructor(
    runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
    platform: NodeJS.Platform = process.platform,
    settleMs: number = SETTLE_MS,
  ) {
    this.#runtime = runtime
    this.#platform = platform
    this.#settleMs = settleMs
  }

  async open(cwd: string, editor: EditorId): Promise<void> {
    if (this.#platform === 'win32' && WINDOWS_UNSAFE.test(cwd)) {
      throw new EditorOpenError('unsupported-path', 'The project path cannot be opened through the Windows shell.')
    }
    const candidates = LAUNCHERS[editor][this.#platform] ?? LAUNCHERS[editor].linux ?? []
    let found = false
    for (const candidate of candidates) {
      const argv = await this.#argv(candidate, cwd)
      if (argv === undefined) continue
      found = true
      if (await this.#launch(argv, cwd)) return
    }
    throw found
      ? new EditorOpenError('launch-failed', 'The editor refused to open the project.')
      : new EditorOpenError('editor-unavailable', 'The editor was not found on PATH.')
  }

  async #argv(candidate: readonly string[], cwd: string): Promise<readonly string[] | undefined> {
    const [program, ...rest] = candidate
    if (program === undefined) return undefined
    // Windows launcher shims are `.cmd` files, which Node refuses to spawn
    // directly; cmd.exe runs those and plain `.exe` entries alike, and does
    // its own PATH/PATHEXT lookup — so no resolution step here.
    if (this.#platform === 'win32') return ['cmd.exe', '/d', '/s', '/c', program, ...rest, cwd]
    try {
      return [await this.#runtime.resolveExecutable(program), ...rest, cwd]
    } catch {
      return undefined
    }
  }

  /** True once the editor is launched: either the shim exited cleanly or the
   *  process is still alive past the settle window. */
  async #launch(argv: readonly string[], cwd: string): Promise<boolean> {
    let handle: SubprocessHandle
    try {
      // No abort signal on purpose — the editor must outlive this request.
      // ponytail: on platforms whose launcher does not fork (idea64.exe) the
      // IDE stays a child of the host; detach if that ever orphans badly.
      handle = this.#runtime.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
        graceMs: 1_000,
        env: {},
      })
    } catch {
      return false
    }
    return await Promise.race([
      handle.done.then(outcome => outcome.exitCode === 0),
      new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(true), this.#settleMs)
        timer.unref?.()
      }),
    ])
  }
}
