import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeQueueDock, type QueueRowView, type QueueSessionSnapshot } from '../src/client/ClaudeQueueDock.tsx'

const t = ((key: string, params?: Record<string, unknown>) => params?.n === undefined ? key : `${key}:${String(params.n)}`) as never

function hook(snapshot: QueueSessionSnapshot) {
  return <T,>(selector: (value: QueueSessionSnapshot) => T): T => selector(snapshot)
}

function row(id: string, preview: string, overrides: Partial<QueueRowView> = {}): QueueRowView {
  return { id, placement: 'queued', preview, text: preview, ...overrides }
}

function render(queue: readonly QueueRowView[], running = false, subagent: unknown = null): string {
  return renderToStaticMarkup(<ClaudeQueueDock useSession={hook({ queue, running, subagent })} t={t} updateQueue={vi.fn()} notify={vi.fn()} />)
}

describe('Claude queue dock', () => {
  it('renders nothing without queued rows and ignores in-flight rows', () => {
    expect(render([])).toBe('')
    expect(render([row('a', 'steering', { placement: 'steering' })])).toBe('')
  })

  it('renders a single queued row inline with edit, remove, and steer actions', () => {
    const idle = render([row('a', 'hello world'), row('b', 'context', { placement: 'context' })])
    expect(idle).toContain('hello world')
    expect(idle).not.toContain('context<')
    expect(idle).toContain('aria-label="queueEdit"')
    expect(idle).toContain('aria-label="queueRemove"')
    expect(idle).toContain('aria-label="queueSteer"')
    expect(idle.match(/disabled=""/g)).toHaveLength(1)
    expect(idle).toContain('width:calc(100% - 64px)')
    expect(render([row('a', 'hello world')], true)).not.toContain('disabled=""')
  })

  it('collapses several rows behind a count and hides actions for subagents', () => {
    const collapsed = render([row('a', 'first'), row('b', 'second'), row('c', 'third')])
    expect(collapsed).toContain('queueCount:3')
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).toContain('hidden=""')
    expect(collapsed).not.toContain('first')
    const subagent = render([row('a', 'first')], true, { id: 'child' })
    expect(subagent).toContain('first')
    expect(subagent).not.toContain('aria-label="queueRemove"')
  })

  it('disables editing for rows without editable text', () => {
    const markup = render([row('a', 'image message', { text: null })], true)
    expect(markup).toContain('aria-label="queueEdit" disabled=""')
    expect(markup).not.toContain('aria-label="queueSteer" disabled=""')
  })
})
