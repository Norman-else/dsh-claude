import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
import {
  boundText,
  safeDetail,
  type ClaudeActivityInput,
  type ClaudeActivityCursor,
} from './events.ts'
import type { UserQuestionBridge } from './user-question.ts'
import { planFeedbackMessage, type PlanFeedbackGate } from './plan-feedback.ts'

export type ApprovalRequester = Pick<ApprovalService, 'request'>

export interface ActivePermissionContext {
  agent: Agent
  cursor: ClaudeActivityCursor
  markActivity?: () => void
  recordDenial?: (toolUseId: string) => void
  hasFullAccess?: () => Promise<boolean>
  appendActivity: (activity: ClaudeActivityInput) => Promise<void>
}

export type ActivePermissionContextProvider = () => ActivePermissionContext | undefined

function denialMessage(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case 'rejected': return 'The user rejected this action in DeepSeek Harness.'
    case 'cancelled': return 'The permission request was cancelled in DeepSeek Harness.'
    case 'unavailable': return 'No DeepSeek Harness approval surface was available; the action was denied.'
    case 'allowed-once': return ''
  }
}

/** Claude leaving plan mode is not an ordinary tool call: its argument is the
 *  plan, written for the user, and the approval that follows is the user
 *  agreeing to it. Everything else reads better as a prompt plus its input. */
const PLAN_TOOL = 'ExitPlanMode'
const MAX_REASON_CHARS = 1_200

/** What the approval dialog says instead of the plan.
 *
 *  A plan is written to be read at length, and the approval dialog is a
 *  cramped modal that renders its reason as plain text: pasting the plan there
 *  turned a document into an unreadable wall. The decision stays with the Host
 *  — this is still an ordinary tool approval — and the plan itself is drawn by
 *  the plugin's own panel, where Markdown and the reader's chosen prose
 *  palette both apply. The dialog only has to say what is being decided and
 *  where to read it. */
const PLAN_APPROVAL_PROMPT = 'Claude proposed a plan. Read it in the Plan panel, then approve or reject here.'

/** The plan an `ExitPlanMode` call carries, if it carries one.
 *
 *  Travels to the client on the permission activity's `text` field: `summary`
 *  is capped at 1k and `detail` at 4k, both of which truncate a real plan,
 *  while `text` holds 64k. Only `kind: 'text'` activities are drawn as prose
 *  by the transcript, so a plan riding a `kind: 'permission'` record reaches
 *  the panel without being painted twice. */
export function planText(toolName: string, input: Readonly<Record<string, unknown>>): string | undefined {
  if (toolName !== PLAN_TOOL) return undefined
  return typeof input.plan === 'string' && input.plan.length > 0 ? input.plan : undefined
}

/** The session's approval-policy override, or undefined when it never switched.
 *
 *  The same fold the approval service does — the last `approval/policy` event
 *  wins, because replaying the log IS the state. Read here rather than
 *  imported so this package keeps its runtime surface to the Host services it
 *  is actually handed. */
export function approvalPolicyOf(events: readonly { type: string; data: unknown }[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'approval/policy') continue
    const policy = (event.data as { policy?: unknown }).policy
    return typeof policy === 'string' ? policy : undefined
  }
  return undefined
}

/** The policy that answers every request with `rejected` before reaching an
 *  answerer, so no approval surface is ever shown. DSH writes it alongside
 *  `sandbox/mode: danger-full-access` — Full access means "stop asking". */
const SILENT_POLICY = 'never'
const ASKING_POLICY = 'ask'

export function permissionReason(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  options: Parameters<CanUseTool>[2],
): string {
  if (planText(toolName, input) !== undefined) return PLAN_APPROVAL_PROMPT
  const prompt = options.title ?? options.description ?? options.decisionReason ?? `Claude Code wants to use ${toolName}.`
  const detail = safeDetail(input)
  return boundText(detail === undefined ? prompt : `${prompt}\nInput: ${detail}`, MAX_REASON_CHARS)
}

export function mapApprovalOutcome(
  outcome: ApprovalOutcome,
  input: Record<string, unknown>,
  toolUseID: string,
): PermissionResult {
  if (outcome === 'allowed-once') {
    return {
      behavior: 'allow',
      updatedInput: input,
      toolUseID,
      decisionClassification: 'user_temporary',
    }
  }
  return {
    behavior: 'deny',
    message: denialMessage(outcome),
    toolUseID,
    decisionClassification: 'user_reject',
  }
}

export function createPermissionBridge(
  approval: ApprovalRequester,
  activeContext: ActivePermissionContextProvider,
  userQuestion?: UserQuestionBridge,
  planFeedback?: PlanFeedbackGate,
): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName === 'AskUserQuestion') {
      return userQuestion === undefined
        ? {
            behavior: 'deny',
            message: 'DeepSeek Harness user questions are unavailable; the question was cancelled.',
            toolUseID: options.toolUseID,
            decisionClassification: 'user_reject',
          }
        : userQuestion(input, options)
    }
    const active = activeContext()
    if (active === undefined) {
      return {
        behavior: 'deny',
        message: 'No active DeepSeek Harness turn owns this Claude Code action.',
        toolUseID: options.toolUseID,
        decisionClassification: 'user_reject',
      }
    }

    active.markActivity?.()
    const reason = permissionReason(toolName, input, options)
    const plan = planText(toolName, input)
    const session = active.agent.session
    // Tracked outside the try so a throw anywhere below still puts the
    // session's own policy back; a failed ask must not leave Full access
    // asking about everything else.
    let silenced = false
    try {
      await active.appendActivity({
        kind: 'permission',
        phase: 'started',
        toolUseId: options.toolUseID,
        toolName,
        title: options.displayName ?? toolName,
        summary: options.title ?? options.description ?? reason,
        detail: input,
        // The plan panel reads this; see planText.
        ...(plan === undefined ? {} : { text: plan }),
      })
      // Full access says "stop asking me before you act". A plan is not an
      // action: it is the decision the user asked Claude to bring back, and
      // answering it on their behalf hands the plan straight back to Claude
      // before anyone has read it. So it is the one approval Full access does
      // not stand in for — a user who wanted the plan waived would not have
      // asked for a plan.
      //
      // Full access does not merely pre-answer the request, it silences it:
      // DSH writes `approval/policy: never` next to the access mode, and the
      // approval service returns `rejected` from that policy alone, before any
      // answerer runs, so no surface is ever shown. Waiving the short-circuit
      // below is therefore not enough — the ask has to be un-silenced for as
      // long as it is open, and put back exactly as it was afterwards.
      const userDecides = plan !== undefined
      silenced = userDecides && approvalPolicyOf(session.events) === SILENT_POLICY
      if (silenced) session.append('approval/policy', { policy: ASKING_POLICY })
      const alreadyFullAccess = !userDecides && await active.hasFullAccess?.() === true
      // Approving and rejecting are the only answers the approval dialog has,
      // and neither is "change this". A reviewer who wants an edit can only
      // reject, which reaches Claude as a bare refusal it cannot act on. So a
      // plan's approval is raced against the panel: the dialog and the panel's
      // notes are two answers to the same question, and whichever arrives
      // first ends it. The loser is aborted rather than left hanging, so a
      // dialog nobody answered does not outlive the plan it was asking about.
      const revision = new AbortController()
      const notes = plan === undefined || planFeedback === undefined
        ? undefined
        : planFeedback.wait(options.toolUseID, AbortSignal.any([options.signal, revision.signal]))
      const decided = new AbortController()
      const asked = alreadyFullAccess
        ? Promise.resolve<ApprovalOutcome>('allowed-once')
        : approval.request({
            agent: active.agent,
            toolName,
            reason,
            signal: notes === undefined ? options.signal : AbortSignal.any([options.signal, decided.signal]),
          })
      const answer = notes === undefined
        ? { outcome: await asked }
        : await Promise.race([
            asked.then(outcome => { revision.abort(); return { outcome } }),
            notes.then(value => value === undefined ? undefined : { revisions: value }),
          ]).then(async first => {
            if (first !== undefined && 'revisions' in first) decided.abort()
            // `notes` resolving undefined means the wait was abandoned, which
            // only happens once the dialog has answered.
            return first ?? { outcome: await asked }
          })
      if ('revisions' in answer) {
        const message = planFeedbackMessage(answer.revisions)
        active.recordDenial?.(options.toolUseID)
        await active.appendActivity({
          kind: 'permission',
          phase: 'denied',
          toolUseId: options.toolUseID,
          toolName,
          title: options.displayName ?? toolName,
          summary: 'Sent back for changes in DeepSeek Harness',
          text: message,
        })
        return {
          behavior: 'deny',
          message,
          toolUseID: options.toolUseID,
          decisionClassification: 'user_reject',
        }
      }
      const outcome = answer.outcome
      // The access selector can change while the approval UI is open. Re-read
      // its durable state so an explicit Full access choice wins over the stale
      // request being closed as rejected/cancelled by that mode transition.
      // Not for a plan: there the user's answer IS the decision, and a Full
      // access switch mid-read must not overturn a rejection they just made.
      const fullAccess = alreadyFullAccess || (!userDecides && await active.hasFullAccess?.() === true)
      const effectiveOutcome = fullAccess ? 'allowed-once' : outcome
      const result = mapApprovalOutcome(effectiveOutcome, input, options.toolUseID)
      if (result.behavior === 'deny') active.recordDenial?.(options.toolUseID)
      await active.appendActivity({
        kind: 'permission',
        phase: effectiveOutcome === 'allowed-once' ? 'completed' : 'denied',
        toolUseId: options.toolUseID,
        toolName,
        title: options.displayName ?? toolName,
        summary: fullAccess
          ? 'Allowed by Full access in DeepSeek Harness'
          : effectiveOutcome === 'allowed-once'
            ? 'Allowed once in DeepSeek Harness'
            : denialMessage(effectiveOutcome),
      })
      return result
    } catch (error) {
      const message = options.signal.aborted
        ? 'The permission request was cancelled in DeepSeek Harness.'
        : 'DeepSeek Harness could not record or answer the permission request; the action was denied.'
      try {
        await active.appendActivity({
          kind: 'permission',
          phase: 'failed',
          toolUseId: options.toolUseID,
          toolName,
          title: options.displayName ?? toolName,
          summary: message,
          isError: true,
          detail: error,
        })
      } catch {
        // The permission path is already fail-closed; a second audit failure cannot widen it.
      }
      return {
        behavior: 'deny',
        message,
        toolUseID: options.toolUseID,
        decisionClassification: 'user_reject',
      }
    } finally {
      // Best effort: an append that fails here cannot be reported without
      // overwriting the decision this call already reached.
      try {
        if (silenced) session.append('approval/policy', { policy: SILENT_POLICY })
      } catch {
        // The session log is the only place this could be recorded, and it is
        // the thing that just failed.
      }
    }
  }
}
