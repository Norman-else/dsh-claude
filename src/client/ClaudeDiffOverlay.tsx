import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface OverlayBounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function shouldRestoreFromEscape(
  event: Pick<KeyboardEvent, 'key'>,
  root: Pick<Document, 'querySelector'> = document,
): boolean {
  return event.key === 'Escape' && root.querySelector('[role="dialog"][aria-modal="true"]') === null
}

export function workspaceBounds(overlay: HTMLElement): OverlayBounds | undefined {
  const frame = overlay.parentElement
  if (frame === null) return undefined
  const overlayRect = overlay.getBoundingClientRect()
  const candidates = Array.from(frame.children)
    .filter(element => element !== overlay)
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
  const insetCandidates = candidates.filter(rect => rect.left > overlayRect.left)
  const pool = insetCandidates.length > 0 ? insetCandidates : candidates
  const workspace = pool.reduce<DOMRect | undefined>((largest, rect) => {
    if (largest === undefined || rect.width * rect.height > largest.width * largest.height) return rect
    return largest
  }, undefined)
  if (workspace === undefined) return undefined
  const left = Math.max(0, workspace.left - overlayRect.left)
  const top = Math.max(0, workspace.top - overlayRect.top)
  return {
    left,
    top,
    width: Math.max(0, Math.min(workspace.width, overlayRect.width - left)),
    height: Math.max(0, Math.min(workspace.height, overlayRect.height - top)),
  }
}

export function observeWorkspaceBounds(overlay: HTMLElement, listener: (bounds: OverlayBounds) => void): () => void {
  const frame = overlay.parentElement
  if (frame === null) return () => {}
  const update = (): void => {
    const next = workspaceBounds(overlay)
    if (next !== undefined) listener(next)
  }
  update()
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
  observer?.observe(frame)
  for (const element of Array.from(frame.children)) observer?.observe(element)
  const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(update)
  mutation?.observe(frame, { attributes: true, childList: true })
  window.addEventListener('resize', update)
  return () => {
    observer?.disconnect()
    mutation?.disconnect()
    window.removeEventListener('resize', update)
  }
}

export function ClaudeDiffOverlay({ children, onRestore }: { children: ReactNode; onRestore: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState<OverlayBounds>()
  useClientLayoutEffect(() => {
    const overlay = ref.current?.closest<HTMLElement>('[data-shell-overlay]')
    if (overlay === undefined || overlay === null) return
    return observeWorkspaceBounds(overlay, next => {
      setBounds(current => (
        current?.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height
          ? current
          : next
      ))
    })
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (shouldRestoreFromEscape(event)) onRestore() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onRestore])
  return (
    <div ref={ref} data-dsh-claude-diff-overlay style={{
      position: 'absolute',
      left: bounds?.left ?? 0,
      top: bounds?.top ?? 0,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
      visibility: bounds === undefined ? 'hidden' : 'visible',
      padding: 8,
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-base)',
      pointerEvents: bounds === undefined ? 'none' : 'auto',
    }}>
      {children}
    </div>
  )
}
