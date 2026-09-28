import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobHooks, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import { ClaudeHostJobs, HOST_JOB_SETTLE_GRACE_MS, hostJobDetail } from '../src/host-jobs.ts'

interface Started {
  spec: JobSpec
  hooks: JobHooks
  progress: string[]
}

function registry() {
  const started: Started[] = []
  const start = vi.fn((spec: JobSpec) => {
    const progress: string[] = []
    const hooks = spec.run({ id: `claude-${started.length + 1}` as never, append: () => undefined, updateProgress: line => { progress.push(line) } })
    started.push({ spec, hooks, progress })
    return `claude-${started.length}` as never
  })
  return { start, started }
}

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function outputFile(taskId: string): string {
  const root = join(tmpdir(), `dsh-claude-host-jobs-${randomUUID()}`)
  roots.push(root)
  mkdirSync(join(root, 'tasks'), { recursive: true })
  return join(root, 'tasks', `${taskId}.output`)
}

function read(job: Started, from: number) {
  return job.spec.output![0]!.read(from)
}

describe('ClaudeHostJobs', () => {
  it('registers a detached task under its session and streams the output file named by the tool result', async () => {
    const jobs = registry()
    const mirror = new ClaudeHostJobs(() => jobs, () => undefined)
    const path = outputFile('bx48f9')
    writeFileSync(path, 'first line\n')
    mirror.noteOutput('dsh-1', `Command running in background with ID: bx48f9. Output is being written to: ${path}. You will be notified.`)
    const stop = vi.fn(async () => undefined)
    mirror.started('dsh-1', 'bx48f9', 'sleep 30 && echo done', stop)
    mirror.started('dsh-1', 'bx48f9', 'sleep 30 && echo done', stop) // level snapshots repeat; one job

    expect(jobs.start).toHaveBeenCalledTimes(1)
    const job = jobs.started[0]!
    expect(job.spec).toMatchObject({ kind: 'claude', label: 'sleep 30 && echo done', owner: 'dsh-1' })

    const head = read(job, 0)
    expect(head).toMatchObject({ text: 'first line\n', nextOffset: 11, lossy: false, spillPath: path })
    appendFileSync(path, 'second\n')
    expect(read(job, head.nextOffset)).toMatchObject({ text: 'second\n', nextOffset: 18 })

    mirror.progress('dsh-1', 'bx48f9', 'waiting on CI')
    expect(job.progress).toEqual(['waiting on CI'])

    job.hooks.cancel('user')
    expect(stop).toHaveBeenCalledTimes(1)

    mirror.settled('dsh-1', 'bx48f9', 'stopped', 'Background command stopped')
    await expect(job.hooks.done).resolves.toEqual({ status: 'killed' })
  })

  it('falls back to the notification output file when no path was seen while running', async () => {
    const jobs = registry()
    const mirror = new ClaudeHostJobs(() => jobs, () => undefined)
    mirror.started('dsh-1', 't1', 'deploy', async () => undefined)
    const job = jobs.started[0]!
    expect(read(job, 0)).toEqual({ text: '', nextOffset: 0, lossy: false })

    const path = outputFile('t1')
    writeFileSync(path, 'all of it\n')
    mirror.settled('dsh-1', 't1', 'failed', 'Background command "deploy" failed (exit code 1)', path)
    // The registry drains sources once more before settlement closes the ring.
    expect(read(job, 0)).toMatchObject({ text: 'all of it\n', nextOffset: 10 })
    await expect(job.hooks.done).resolves.toEqual({ status: 'failed', detail: 'exit code: 1' })
  })

  it('settles a task that left the live set unless its notification arrives within the grace period', async () => {
    vi.useFakeTimers()
    const jobs = registry()
    const mirror = new ClaudeHostJobs(() => jobs, () => undefined)
    mirror.started('dsh-1', 'a', 'a', async () => undefined)
    mirror.started('dsh-1', 'b', 'b', async () => undefined)
    mirror.removed('dsh-1', 'a')
    mirror.removed('dsh-1', 'b')
    mirror.settled('dsh-1', 'b', 'failed', 'exit code 3')
    vi.advanceTimersByTime(HOST_JOB_SETTLE_GRACE_MS)
    await expect(jobs.started[0]!.hooks.done).resolves.toEqual({ status: 'completed' })
    await expect(jobs.started[1]!.hooks.done).resolves.toEqual({ status: 'failed', detail: 'exit code: 3' })
  })

  it('fails the session\'s live jobs when its CLI process is gone', async () => {
    const jobs = registry()
    const mirror = new ClaudeHostJobs(() => jobs, () => undefined)
    mirror.started('dsh-1', 'a', 'a', async () => undefined)
    mirror.started('dsh-2', 'b', 'b', async () => undefined)
    mirror.abandon('dsh-1')
    await expect(jobs.started[0]!.hooks.done).resolves.toEqual({ status: 'failed', detail: 'Claude Code exited' })
    const other = await Promise.race([jobs.started[1]!.hooks.done, Promise.resolve('live' as const)])
    expect(other).toBe('live')
  })

  it('warns once and keeps going when the Host refuses the registration', () => {
    const warnings: string[] = []
    const start = vi.fn((_spec: JobSpec): never => { throw new Error('no attached job controller serves dsh-1') })
    const mirror = new ClaudeHostJobs(() => ({ start }), message => { warnings.push(message) })
    mirror.started('dsh-1', 'a', 'a', async () => undefined)
    mirror.started('dsh-1', 'b', 'b', async () => undefined)
    mirror.progress('dsh-1', 'a', 'ignored')
    mirror.settled('dsh-1', 'a', 'completed')
    expect(start).toHaveBeenCalledTimes(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no attached job controller')
  })

  it('does nothing without a registry', () => {
    const mirror = new ClaudeHostJobs(() => undefined, () => { throw new Error('unexpected') })
    mirror.started('dsh-1', 'a', 'a', async () => undefined)
    mirror.settled('dsh-1', 'a', 'completed')
  })

  it('derives the row detail from the summary', () => {
    expect(hostJobDetail('completed', 'Background command "x" completed (exit code 0)')).toBe('exit code: 0')
    expect(hostJobDetail('completed', 'Agent finished its report')).toBeUndefined()
    expect(hostJobDetail('failed', 'Agent hit an error')).toBe('Agent hit an error')
    expect(hostJobDetail('killed', undefined)).toBeUndefined()
  })
})

// Type-level check: the outcome shape this file asserts on is the registry's.
const _outcome: JobOutcome = { status: 'completed' }
void _outcome
