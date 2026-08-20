import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER } from './constants.ts'
import type { ClaudeSupervisor, ClaudeThinkingMode } from './supervisor.ts'
import type { ClaudeUsage } from './events.ts'

const MODELS = [
  { id: 'default', name: 'Default (recommended)', description: 'Use Claude Code’s recommended default model.' },
  { id: 'opus[1m]', name: 'Opus (1M context)', description: 'Use Opus with a 1M-token context window.', contextWindow: 1_000_000 },
  { id: 'fable', name: 'Fable', description: 'Use Fable, Claude Code’s most capable coding model.' },
  { id: 'sonnet', name: 'Sonnet', description: 'Use Sonnet for efficient routine coding work.' },
  { id: 'haiku', name: 'Haiku', description: 'Use Haiku for fast, lightweight tasks.' },
] as const

const THINKING_MODES = [
  { id: 'off', name: 'Off', description: 'No extended thinking.' },
  { id: 'low', name: 'Low', description: 'Minimal thinking, fastest responses.' },
  { id: 'medium', name: 'Medium', description: 'Moderate thinking.' },
  { id: 'high', name: 'High', description: 'Deep reasoning (Claude Code default).' },
  { id: 'xhigh', name: 'Extra High', description: 'Deeper than high; unsupported models silently downgrade to high.' },
  { id: 'max', name: 'Max', description: 'Maximum effort; unsupported models silently downgrade.' },
  { id: 'ultracode', name: 'Ultracode', description: 'Extra-high effort plus standing dynamic-workflow orchestration; requires an xhigh-capable model.' },
] as const

export function thinkingModeFor(effort: ReasoningEffortId | undefined): ClaudeThinkingMode | undefined {
  if (effort === undefined) return undefined
  if (THINKING_MODES.some(mode => mode.id === (effort as string))) return effort as unknown as ClaudeThinkingMode
  throw new Error(`dsh-claude: unsupported reasoning effort ${JSON.stringify(effort)}`)
}

const NO_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

export function extractDirectUserText(messages: GenerateOptions['messages']): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message.source.kind !== 'user') continue
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
    if (message.content.some(block => block.type === 'image')) {
      throw new Error('dsh-claude: image-only prompts are not supported in v0.1; include a text prompt')
    }
  }
  throw new Error('dsh-claude: no direct human text was present in this model step')
}

function tokenUsage(usage: ClaudeUsage): TokenUsage {
  const normalized: TokenUsage = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  }
  if (usage.cacheReadTokens !== undefined) normalized.cacheReadTokens = usage.cacheReadTokens
  if (usage.cacheCreationTokens !== undefined) normalized.cacheWriteTokens = usage.cacheCreationTokens
  return normalized
}

function resolveAgent(agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>, options: GenerateOptions): Agent {
  const initiator = agents.currentInitiator()
  if (initiator !== undefined) return initiator
  if (options.sessionId !== undefined) {
    const agent = agents.get(options.sessionId)
    if (agent !== undefined) return agent
  }
  throw new Error('dsh-claude: the model request has no live owning DSH agent')
}

export class ClaudeCodeAdapter extends LlmAdapter {
  readonly #supervisor: ClaudeSupervisor
  readonly #agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>
  readonly #presetIdFor: (agent: Agent) => string | undefined

  constructor(
    supervisor: ClaudeSupervisor,
    agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>,
    presetIdFor: (agent: Agent) => string | undefined,
  ) {
    super()
    this.#supervisor = supervisor
    this.#agents = agents
    this.#presetIdFor = presetIdFor
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return NO_RETRY_POLICY
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return MODELS.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.description,
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = MODELS.find(item => item.id === model)
    const observedContextWindow = this.#supervisor.contextWindow(model)
    const contextWindow = observedContextWindow ?? (known !== undefined && 'contextWindow' in known ? known.contextWindow : undefined)
    return {
      provider,
      id: model,
      name: known?.name ?? `Claude Code ${model}`,
      ...(known === undefined ? {} : { description: known.description }),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      inputModalities: ['text'],
      reasoning: {
        efforts: THINKING_MODES.map(mode => ({
          id: ReasoningEffortId(mode.id),
          name: mode.name,
          description: mode.description,
        })),
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      throw new Error(`dsh-claude: auxiliary ${options.purpose} calls are not routed into the Claude session`)
    }
    const agent = resolveAgent(this.#agents, options)
    if (this.#presetIdFor(agent) !== CLAUDE_CODE_PRESET_ID) {
      throw new Error(`dsh-claude: provider ${CLAUDE_CODE_PROVIDER} is available only to the ${CLAUDE_CODE_PRESET_ID} preset`)
    }
    const thinkingMode = thinkingModeFor(options.reasoningEffort)
    const prompt = extractDirectUserText(options.messages)
    const events = await this.#supervisor.runTurn({
      agent,
      prompt,
      model: options.model,
      ...(thinkingMode === undefined ? {} : { thinkingMode }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    let text = ''
    let pendingUsage: TokenUsage | undefined
    let completed = false
    try {
      for await (const event of events) {
        if (event.type === 'text-delta') {
          // Buffered, not live-streamed: Claude's intermediate prose and final
          // answer settle as one block at the turn's durable position, below
          // the step's mirrored tool cards, instead of jumping there at the end.
          text += event.text
        } else if (event.type === 'usage') {
          pendingUsage = tokenUsage(event.usage)
        } else {
          completed = true
          if (text.length > 0) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          }
          if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        completed = true
        if (text.length > 0) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: { code: 'aborted', message: error instanceof Error ? error.message : 'Claude Code turn aborted' },
          },
        }
        return
      }
      throw error
    }
    if (!completed) throw new Error('dsh-claude: Claude turn stream ended without a result')
  }
}

export function createClaudeCodeAdapter(
  supervisor: ClaudeSupervisor,
  agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>,
  presetIdFor: (agent: Agent) => string | undefined,
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(supervisor, agents, presetIdFor)
}
