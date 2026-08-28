// @vitest-environment jsdom
import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionableUser } from '../src/pr-feedback.ts'
import { MentionTextarea } from '../src/client/MentionTextarea.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let mounted: { root: Root; container: HTMLElement } | undefined

/** The composer is controlled, so the test drives it the way the panel does. */
function Harness({ initial, suggest, onValue, onSubmit }: {
  initial: string
  suggest: (query: string) => Promise<readonly MentionableUser[]>
  onValue: (value: string) => void
  onSubmit?: () => void
}) {
  const [value, setValue] = useState(initial)
  return <MentionTextarea
    value={value}
    placeholder="Reply"
    suggestLabel="Mention a user"
    suggest={suggest}
    onChange={(next) => { setValue(next); onValue(next) }}
    {...(onSubmit === undefined ? {} : { onSubmit })}
  />
}

function mount(node: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  act(() => { root.render(node) })
  return container
}

/** React deduplicates a value it set itself, so typing goes through the
 *  prototype setter the way a real keystroke does. */
function type(area: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(area, text)
    area.selectionStart = text.length
    area.selectionEnd = text.length
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(area: HTMLTextAreaElement, key: string): void {
  act(() => { area.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  vi.useRealTimers()
  if (mounted === undefined) return
  const { root, container } = mounted
  act(() => { root.unmount() })
  container.remove()
  mounted = undefined
})

describe('mention textarea', () => {
  it('completes a handle from the suggestions the repository offers', async () => {
    const suggest = vi.fn(async () => [{ login: 'alice' }, { login: 'albert' }])
    const onChange = vi.fn()
    const container = mount(<Harness initial="" suggest={suggest} onValue={onChange} />)
    const area = container.querySelector('textarea')
    if (area === null) throw new Error('no textarea')

    type(area, 'Thanks @al')
    // The lookup is debounced: typing does not fire a request per keystroke.
    expect(suggest).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(suggest).toHaveBeenCalledWith('al')

    const options = container.querySelectorAll('[role="option"]')
    expect([...options].map(option => option.textContent)).toEqual(['alice', 'albert'])

    press(area, 'ArrowDown')
    press(area, 'Enter')
    expect(onChange).toHaveBeenLastCalledWith('Thanks @albert ')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  it('keeps out of the way when the caret is not in a handle', async () => {
    const suggest = vi.fn(async () => [{ login: 'alice' }])
    const container = mount(<Harness initial="" suggest={suggest} onValue={vi.fn()} />)
    const area = container.querySelector('textarea')
    if (area === null) throw new Error('no textarea')

    type(area, 'no handle here')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(suggest).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  it('dismisses the popup on Escape without swallowing the next Enter', async () => {
    const suggest = vi.fn(async () => [{ login: 'alice' }])
    const onSubmit = vi.fn()
    const container = mount(<Harness initial="" suggest={suggest} onValue={vi.fn()} onSubmit={onSubmit} />)
    const area = container.querySelector('textarea')
    if (area === null) throw new Error('no textarea')

    type(area, '@al')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)

    press(area, 'Escape')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    // With the popup closed the composer shortcut belongs to the form again.
    act(() => { area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
