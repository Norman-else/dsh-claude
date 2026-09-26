import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { HANDOFF_HOLD_BUDGET_MS } from '../plugin-budget.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** dsh-claude handing a prepared draft to a freshly created worktree Session. */
    claudeWorktreeHandoff: unknown
  }
}

interface HandoffSessionSnapshot {
  readonly running?: boolean
  readonly pendingSubmissions?: readonly unknown[]
}

interface HandoffSession {
  subscribe(listener: () => void): () => void
  getSnapshot(): HandoffSessionSnapshot
}

/** Retain a Session this plugin just created so its scope can be borrowed.
 *
 *  Host 0.1.7 hands out `sessions.scope()` only for a retained generation; a
 *  Session created through `connectWorkspace` has no holder until the main
 *  view opens it, so the worktree hand-off borrowed nothing and failed with
 *  "could not prepare the target session". */
export async function retainForHandoff(sessions: Pick<ISessions, 'retain'>, id: SessionId): Promise<SessionReference> {
  const reference = sessions.retain(id, { source: 'claudeWorktreeHandoff' })
  try {
    await reference.ready
  } catch (error) {
    reference.release()
    throw error
  }
  return reference
}

/** Release the hand-off's hold once the Host has taken the submitted draft.
 *
 *  `submit()` returns before the message leaves the Client, and the last
 *  release tears the scope down, aborting a submission still in flight. The
 *  draft counts as taken once the Session runs or its pending submission
 *  drains; the timeout bounds a Host that reports neither. */
export function releaseAfterSubmission(reference: SessionReference, timeoutMs = HANDOFF_HOLD_BUDGET_MS): void {
  const session = reference.binding.session as unknown as HandoffSession
  let sawPending = false
  let released = false
  let unsubscribe = (): void => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const release = (): void => {
    if (released) return
    released = true
    unsubscribe()
    if (timer !== undefined) clearTimeout(timer)
    reference.release()
  }
  const taken = (): boolean => {
    const snapshot = session.getSnapshot()
    const pending = snapshot.pendingSubmissions?.length ?? 0
    if (pending > 0) sawPending = true
    return snapshot.running === true || (sawPending && pending === 0)
  }
  unsubscribe = session.subscribe(() => { if (taken()) release() })
  timer = setTimeout(release, timeoutMs)
  if (taken()) release()
}
