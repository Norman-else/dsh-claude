/**
 * Mirror Claude Code's background tasks into the Host job registry
 * (`ctx.jobs`), so they show up in the session header's background-job list
 * with live output and a working stop button. Claude Code still owns the
 * work; this is presentation plus a kill relay.
 *
 * Output: the CLI writes each task's stream to `<taskId>.output` and names
 * that path in the tool result that backgrounded the command, so the path is
 * lifted from tool results while the task runs. When no path was seen, the
 * `task_notification.output_file` at settlement is used instead: the
 * registry drains pull sources once more before it closes the ring, so the
 * whole file lands then.
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { JobHandle, JobOutcome, JobRegistry, JobSourceRead } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap {
    claude: 'claude'
  }
}

export type ClaudeHostJobStatus = 'completed' | 'failed' | 'stopped' | 'killed'

/** How long a task that left the live set may wait for its notification
 *  (which carries the real status) before it is settled as completed. */
export const HOST_JOB_SETTLE_GRACE_MS = 2_000

interface MirroredJob {
  handle: JobHandle
  settle: (outcome: JobOutcome) => void
  stop: () => Promise<void>
  path?: string
  readonly decoder: StringDecoder
  removal?: ReturnType<typeof setTimeout>
}

const OUTPUT_PATH = /([^\s"'`]+[\\/]([A-Za-z0-9_-]+)\.output)(?!\w)/g

function keyOf(sessionId: string, taskId: string): string {
  return `${sessionId}\n${taskId}`
}

function readOutput(job: MirroredJob, from: number): JobSourceRead {
  const none: JobSourceRead = { text: '', nextOffset: from, lossy: false }
  if (job.path === undefined) return none
  let fd: number
  try {
    fd = openSync(job.path, 'r')
  } catch {
    return none
  }
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const chunks: string[] = []
    let position = from
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position)
      if (read === 0) break
      chunks.push(job.decoder.write(buffer.subarray(0, read)))
      position += read
    }
    return { text: chunks.join(''), nextOffset: position, lossy: false, spillPath: job.path }
  } finally {
    closeSync(fd)
  }
}

/** The terminal reason the row shows: the exit code when the summary names
 *  one, otherwise the failure summary itself. */
export function hostJobDetail(status: ClaudeHostJobStatus, summary: string | undefined): string | undefined {
  const exitCode = summary === undefined ? null : /exit code:? (\d+)/i.exec(summary)
  if (exitCode !== null) return `exit code: ${exitCode[1]}`
  if (status === 'failed' && summary !== undefined) return summary.length > 200 ? `${summary.slice(0, 199)}…` : summary
  return undefined
}

export class ClaudeHostJobs {
  readonly #registry: () => Pick<JobRegistry, 'start'> | undefined
  readonly #warn: (message: string) => void
  readonly #jobs = new Map<string, MirroredJob>()
  /** Output paths seen in tool results before the task itself registered. */
  readonly #paths = new Map<string, string>()
  #warned = false

  constructor(registry: () => Pick<JobRegistry, 'start'> | undefined, warn: (message: string) => void) {
    this.#registry = registry
    this.#warn = warn
  }

  /** Register one detached task; `stop` relays the Host's kill to the CLI. */
  started(sessionId: string, taskId: string, label: string, stop: () => Promise<void>): void {
    const key = keyOf(sessionId, taskId)
    if (this.#jobs.has(key)) return
    const registry = this.#registry()
    if (registry === undefined) return
    const job = { decoder: new StringDecoder('utf8'), stop } as MirroredJob
    const path = this.#paths.get(key)
    if (path !== undefined) {
      this.#paths.delete(key)
      job.path = path
    }
    try {
      registry.start({
        kind: 'claude',
        label,
        owner: sessionId as never,
        output: [{ channel: 'stdout', read: from => readOutput(job, from) }],
        run: handle => {
          job.handle = handle
          return {
            cancel: () => {
              void job.stop().catch((error: unknown) => {
                this.#warn(`dsh-claude: stopping Claude task ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
              })
            },
            done: new Promise<JobOutcome>(resolve => { job.settle = resolve }),
          }
        },
      })
      this.#jobs.set(key, job)
    } catch (error) {
      // No registry controller serves this owner, or the Host predates the
      // contract: Claude's own task board still shows the work.
      if (this.#warned) return
      this.#warned = true
      this.#warn(`dsh-claude: Host background-job list unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  progress(sessionId: string, taskId: string, line: string): void {
    this.#jobs.get(keyOf(sessionId, taskId))?.handle.updateProgress(line)
  }

  /** Lift `<taskId>.output` paths out of a tool result. */
  noteOutput(sessionId: string, output: unknown): void {
    const text = typeof output === 'string' ? output : safeJson(output)
    if (text === undefined || !text.includes('.output')) return
    for (const match of text.matchAll(OUTPUT_PATH)) {
      const key = keyOf(sessionId, match[2]!)
      const job = this.#jobs.get(key)
      if (job === undefined) this.#paths.set(key, match[1]!)
      else job.path ??= match[1]!
    }
  }

  /** The level signal dropped the task; settle it as completed unless the
   *  notification with the real status arrives within the grace period. */
  removed(sessionId: string, taskId: string): void {
    const job = this.#jobs.get(keyOf(sessionId, taskId))
    if (job === undefined || job.removal !== undefined) return
    job.removal = setTimeout(() => { this.settled(sessionId, taskId, 'completed') }, HOST_JOB_SETTLE_GRACE_MS)
    job.removal.unref?.()
  }

  settled(sessionId: string, taskId: string, status: ClaudeHostJobStatus, summary?: string, outputFile?: string): void {
    const key = keyOf(sessionId, taskId)
    const job = this.#jobs.get(key)
    this.#paths.delete(key)
    if (job === undefined) return
    this.#jobs.delete(key)
    if (job.removal !== undefined) clearTimeout(job.removal)
    if (outputFile !== undefined) job.path ??= outputFile
    const detail = hostJobDetail(status, summary)
    job.settle({
      status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'killed',
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** The CLI process behind these tasks is gone; nothing will report them. */
  abandon(sessionId: string): void {
    const prefix = `${sessionId}\n`
    for (const key of [...this.#jobs.keys()]) {
      if (key.startsWith(prefix)) this.settled(sessionId, key.slice(prefix.length), 'failed', 'Claude Code exited')
    }
    for (const key of [...this.#paths.keys()]) {
      if (key.startsWith(prefix)) this.#paths.delete(key)
    }
  }
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
