const DETAILS_MIN_WIDTH = 300
const DETAILS_DEFAULT_WIDTH = 480
const DETAILS_MAX_RATIO = 0.5
const DRAG_THRESHOLD = 4

export function clampDetailsWidth(width: number, frameWidth: number): number {
  const maximum = Math.max(DETAILS_MIN_WIDTH, Math.floor(frameWidth * DETAILS_MAX_RATIO))
  return Math.min(maximum, Math.max(DETAILS_MIN_WIDTH, Math.round(width)))
}

export function defaultDetailsWidth(frameWidth: number): number {
  return clampDetailsWidth(DETAILS_DEFAULT_WIDTH, frameWidth)
}

function pixelValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Extends the native Details drag handle for the plugin Diff panel without
 * depending on DSH's private layout store. The returned cleanup restores every
 * inline value owned by the native frame.
 */
export function enableExpandedDetailsResize(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined

  let frame: HTMLElement | undefined
  let handle: HTMLElement | undefined
  let width: number | undefined
  let dragStartX = 0
  let dragStartWidth = 0
  let pointerId: number | undefined
  let dragged = false
  let originalGrid = ''
  let originalHandleLeft = ''
  let frameWasDragging = false
  let handleWasDragging = false
  let resizeObserver: ResizeObserver | undefined
  let mutationObserver: MutationObserver | undefined
  let animationFrame: number | undefined

  const applyWidth = (): void => {
    if (frame === undefined || handle === undefined || width === undefined) return
    const frameWidth = frame.getBoundingClientRect().width
    if (frameWidth <= 0) return
    width = clampDetailsWidth(width, frameWidth)
    const tracks = getComputedStyle(frame).gridTemplateColumns.split(/\s+/u)
    const sidebar = pixelValue(tracks[0] ?? '') ?? 0
    const grid = `${sidebar}px minmax(0, 1fr) ${width}px`
    const left = `${frameWidth - width}px`
    if (frame.style.gridTemplateColumns !== grid) frame.style.gridTemplateColumns = grid
    if (handle.style.left !== left) handle.style.left = left
  }

  const scheduleApply = (): void => {
    if (animationFrame !== undefined) return
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = undefined
      applyWidth()
    })
  }

  const finishDrag = (): void => {
    if (pointerId === undefined) return
    pointerId = undefined
    if (frame !== undefined && !frameWasDragging) frame.removeAttribute('data-dragging')
    if (handle !== undefined && !handleWasDragging) handle.removeAttribute('data-dragging')
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId || frame === undefined) return
    const delta = event.clientX - dragStartX
    if (!dragged && Math.abs(delta) < DRAG_THRESHOLD) return
    dragged = true
    width = clampDetailsWidth(dragStartWidth - delta, frame.getBoundingClientRect().width)
    applyWidth()
    event.preventDefault()
  }

  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return
    finishDrag()
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const candidate = target.closest<HTMLElement>('[data-side="details"]')
    const candidateFrame = candidate?.parentElement
    if (candidate === null || candidate === undefined || candidateFrame === null || candidateFrame === undefined) return
    const currentFrame = candidateFrame
    const currentHandle = candidate
    const detailsColumn = currentFrame.children.item(2)
    const measuredWidth = detailsColumn instanceof HTMLElement ? detailsColumn.getBoundingClientRect().width : 0
    const frameWidth = currentFrame.getBoundingClientRect().width
    if (measuredWidth <= 0 || frameWidth <= 0) return

    const firstDrag = frame === undefined
    frame = currentFrame
    handle = currentHandle
    width = clampDetailsWidth(width ?? measuredWidth, frameWidth)
    dragStartWidth = width
    dragStartX = event.clientX
    pointerId = event.pointerId
    dragged = false
    if (firstDrag) {
      originalGrid = currentFrame.style.gridTemplateColumns
      originalHandleLeft = currentHandle.style.left
      frameWasDragging = currentFrame.hasAttribute('data-dragging')
      handleWasDragging = currentHandle.hasAttribute('data-dragging')
    }
    currentFrame.setAttribute('data-dragging', '')
    currentHandle.setAttribute('data-dragging', 'true')

    if (firstDrag) {
      resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleApply)
      resizeObserver?.observe(currentFrame)
      mutationObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(scheduleApply)
      mutationObserver?.observe(currentFrame, { attributes: true, attributeFilter: ['style'] })
      mutationObserver?.observe(currentHandle, { attributes: true, attributeFilter: ['style'] })
    }

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  const applyDefaultWidth = (): void => {
    const initialHandle = document.querySelector<HTMLElement>('[data-side="details"]')
    const initialFrame = initialHandle?.parentElement
    if (initialHandle === null || initialHandle === undefined || initialFrame === null || initialFrame === undefined) return
    frame = initialFrame
    handle = initialHandle
    originalGrid = frame.style.gridTemplateColumns
    originalHandleLeft = handle.style.left
    frameWasDragging = frame.hasAttribute('data-dragging')
    handleWasDragging = handle.hasAttribute('data-dragging')
    width = defaultDetailsWidth(frame.getBoundingClientRect().width)
    resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleApply)
    resizeObserver?.observe(frame)
    mutationObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(scheduleApply)
    mutationObserver?.observe(frame, { attributes: true, attributeFilter: ['style'] })
    mutationObserver?.observe(handle, { attributes: true, attributeFilter: ['style'] })
    applyWidth()
  }

  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = undefined
    applyDefaultWidth()
  })
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerEnd, true)
    window.removeEventListener('pointercancel', onPointerEnd, true)
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
    finishDrag()
    if (frame !== undefined) frame.style.gridTemplateColumns = originalGrid
    if (handle !== undefined) handle.style.left = originalHandleLeft
  }
}
