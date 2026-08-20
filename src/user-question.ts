import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  UserQuestionService,
} from '@deepseek-ai/dsh-user-questions'
import type { ClaudeActivityInput, ClaudeActivityCursor } from './events.ts'

export type UserQuestionRequester = Pick<UserQuestionService, 'ask'>

export interface ActiveUserQuestionContext {
  agent: Agent
  cursor: ClaudeActivityCursor
  markActivity?: () => void
  appendActivity: (activity: ClaudeActivityInput) => Promise<void>
}

export type ActiveUserQuestionContextProvider = () => ActiveUserQuestionContext | undefined
export type UserQuestionBridge = (
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
) => Promise<PermissionResult>

const FAILURE_MESSAGE = 'DeepSeek Harness could not collect an answer; the question was cancelled.'
const INVALID_MESSAGE = 'Claude Code sent an invalid user-question request; the question was cancelled.'

function failureMessage(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)
    ? `${FAILURE_MESSAGE} (${code})`
    : FAILURE_MESSAGE
}

function deny(message: string, toolUseID: string): PermissionResult {
  return {
    behavior: 'deny',
    message,
    toolUseID,
    decisionClassification: 'user_reject',
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseQuestions(input: Record<string, unknown>, toolUseID: string): AskUserQuestionItem[] | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > 20) return undefined
  const seen = new Set<string>()
  const questions: AskUserQuestionItem[] = []
  for (const [index, value] of input.questions.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const item = value as Record<string, unknown>
    if (typeof item.question !== 'string' || item.question.length === 0 || seen.has(item.question)) return undefined
    seen.add(item.question)
    if (item.options !== undefined && !Array.isArray(item.options)) return undefined
    const options = (item.options ?? []).map(option => {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) return undefined
      const record = option as Record<string, unknown>
      if (typeof record.label !== 'string' || record.label.length === 0) return undefined
      const description = optionalText(record.description)
      return { label: record.label, ...(description === undefined ? {} : { description }) }
    })
    if (options.some(option => option === undefined)) return undefined
    const header = optionalText(item.header)
    questions.push({
      id: `${toolUseID}:${index}`,
      question: item.question,
      ...(header === undefined ? {} : { header }),
      options: options as NonNullable<AskUserQuestionItem['options']>,
      multiSelect: item.multiSelect === true,
    })
  }
  return questions
}

function answerText(answer: AskUserQuestionAnswerItem | undefined, multiSelect: boolean): string {
  if (answer === undefined) return ''
  const custom = optionalText(answer.custom)
  if (!multiSelect && custom !== undefined) return custom
  return [...answer.selected, ...(custom === undefined ? [] : [custom])].join(', ')
}

export function createUserQuestionBridge(
  userQuestions: UserQuestionRequester,
  activeContext: ActiveUserQuestionContextProvider,
): UserQuestionBridge {
  return async (input, options) => {
    const active = activeContext()
    if (active === undefined) return deny('No active DeepSeek Harness turn owns this Claude Code question.', options.toolUseID)

    const questions = parseQuestions(input, options.toolUseID)
    if (questions === undefined) return deny(INVALID_MESSAGE, options.toolUseID)

    active.markActivity?.()
    try {
      await active.appendActivity({
        kind: 'question',
        phase: 'started',
        toolUseId: options.toolUseID,
        toolName: 'AskUserQuestion',
        title: 'Claude asked a question',
        summary: questions.length === 1 ? questions[0]!.question : `Claude asked ${questions.length} questions`,
      })
      const response = await userQuestions.ask({
        questions,
        agent: active.agent,
        signal: options.signal,
      })
      const answersById = new Map(response.answers.map(answer => [answer.id, answer]))
      const answers = Object.fromEntries(questions.map(question => [
        question.question,
        answerText(answersById.get(question.id), question.multiSelect === true),
      ]))
      await active.appendActivity({
        kind: 'question',
        phase: 'completed',
        toolUseId: options.toolUseID,
        toolName: 'AskUserQuestion',
        title: 'Claude asked a question',
        summary: 'Answered in DeepSeek Harness',
      })
      return {
        behavior: 'allow',
        updatedInput: { ...input, answers },
        toolUseID: options.toolUseID,
        decisionClassification: 'user_temporary',
      }
    } catch (error) {
      const message = failureMessage(error)
      try {
        await active.appendActivity({
          kind: 'question',
          phase: 'failed',
          toolUseId: options.toolUseID,
          toolName: 'AskUserQuestion',
          title: 'Claude asked a question',
          summary: message,
          isError: true,
        })
      } catch {
        // The question path is fail-closed; a second audit failure cannot widen it.
      }
      return deny(message, options.toolUseID)
    }
  }
}
