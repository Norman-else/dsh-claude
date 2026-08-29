import { useCallback, useState, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ActionToast {
  readonly id: number
  readonly text: string
}

/** Always a new id, even for the same text: the id is the Toast's key, and
 *  reporting the same outcome twice has to replay the banner rather than
 *  update the text of one that is already fading out. */
export function nextActionToast(current: ActionToast | undefined, text: string): ActionToast {
  return { id: (current?.id ?? 0) + 1, text }
}

/** Report a finished Git action the way the Host reports everything else: a
 *  banner over the window, not a line inside the dialog that asked for it. The
 *  dialog closes the moment the work lands, so the notice has to outlive it. */
export function useActionToast(): { readonly toast: ReactNode; readonly report: (text: string) => void } {
  const [shown, setShown] = useState<ActionToast>()
  const done = useCallback(() => { setShown(undefined) }, [])
  const report = useCallback((text: string) => { setShown(current => nextActionToast(current, text)) }, [])
  return { toast: shown === undefined ? null : <Toast key={shown.id} text={shown.text} onDone={done} />, report }
}
