import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER, DEFAULT_CLAUDE_RENDER_MODE, type ClaudeRenderMode } from './constants.ts'
import type { ClaudeSupervisor, ClaudeThinkingMode } from './supervisor.ts'
import type { ClaudeUsage } from './events.ts'
import { claudeModelRow, latestClaudeModels } from './model-catalog.ts'
import { formatReviewComments, type ReviewComment } from './review-comments.ts'

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

type ClaudePrompt = SDKUserMessage['message']['content']
type ClaudePromptBlock = Exclude<ClaudePrompt, string>[number]
type AttachmentReader = Pick<AttachmentStore, 'imageLimits' | 'readImage'>

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Claude Code input resolution aborted')
  error.name = 'AbortError'
  throw error
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validateImageRef(ref: ImageAttachmentRef, attachments: AttachmentReader, imageIndex: number): void {
  const limits = attachments.imageLimits
  if (!limits.mediaTypes.includes(ref.mediaType)) {
    throw new Error(`dsh-claude: image ${imageIndex} has an unsupported media type`)
  }
  if (!finiteNonNegative(ref.bytes) || ref.bytes > limits.maxImageBytes) {
    throw new Error(`dsh-claude: image ${imageIndex} exceeds the configured byte limit`)
  }
  const maxDimension = 'maxImageDimension' in limits && finiteNonNegative(limits.maxImageDimension)
    ? limits.maxImageDimension
    : undefined
  if (!finiteNonNegative(ref.width) || !finiteNonNegative(ref.height)
    || ref.width * ref.height > limits.maxImagePixels
    || (maxDimension !== undefined && (ref.width > maxDimension || ref.height > maxDimension))) {
    throw new Error(`dsh-claude: image ${imageIndex} exceeds the configured dimension limit`)
  }
}

/**
 * Prepend the session's pending diff-review comments to the outgoing user
 * prompt. The comments are drained once per turn: they are formatted into one
 * `<user-review-comments>` block placed ahead of the user's own text (or as a
 * leading text block for multi-part prompts) so Claude reads them in the same
 * turn that consumed them.
 */
export function injectReviewComments(prompt: ClaudePrompt, comments: readonly ReviewComment[]): ClaudePrompt {
  if (comments.length === 0) return prompt
  const block = formatReviewComments(comments)
  if (typeof prompt === 'string') return `${block}\n\n${prompt}`
  return [{ type: 'text', text: block }, ...prompt]
}

function imageBlock(data: Uint8Array, mediaType: ImageMediaType): ClaudePromptBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
    },
  }
}

/** Resolve only the newest direct human message; Claude's session owns history. */
export async function resolveDirectUserPrompt(
  messages: GenerateOptions['messages'],
  attachments: AttachmentReader,
  signal?: AbortSignal,
): Promise<ClaudePrompt> {
  const message = [...messages].reverse().find(candidate => (
    candidate.role === 'user' && candidate.source.kind === 'user'
  ))
  if (message === undefined) {
    throw new Error('dsh-claude: no direct human input was present in this model step')
  }

  const imageRefs = message.content
    .filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
    .map(block => block.attachment)
  const limits = attachments.imageLimits
  if (imageRefs.length > limits.maxImagesPerMessage) {
    throw new Error('dsh-claude: prompt exceeds the configured image-count limit')
  }
  let declaredBytes = 0
  imageRefs.forEach((ref, index) => {
    validateImageRef(ref, attachments, index + 1)
    declaredBytes += ref.bytes
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.maxMessageImageBytes) {
      throw new Error('dsh-claude: prompt exceeds the configured aggregate image-byte limit')
    }
  })

  if (imageRefs.length === 0) {
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
    throw new Error('dsh-claude: the newest direct human message has no supported content')
  }

  const content: ClaudePromptBlock[] = []
  let imageIndex = 0
  let verifiedBytes = 0
  for (const block of message.content) {
    abortIfRequested(signal)
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    imageIndex += 1
    let stored: Awaited<ReturnType<AttachmentStore['readImage']>>
    try {
      stored = await attachments.readImage(block.attachment, signal)
    } catch {
      abortIfRequested(signal)
      throw new Error(`dsh-claude: image ${imageIndex} could not be read or verified`)
    }
    abortIfRequested(signal)
    validateImageRef(stored.ref, attachments, imageIndex)
    if (stored.data.byteLength !== stored.ref.bytes || stored.ref.mediaType !== block.attachment.mediaType) {
      throw new Error(`dsh-claude: image ${imageIndex} failed attachment verification`)
    }
    verifiedBytes += stored.data.byteLength
    if (!Number.isSafeInteger(verifiedBytes) || verifiedBytes > limits.maxMessageImageBytes) {
      throw new Error('dsh-claude: prompt exceeds the configured aggregate image-byte limit')
    }
    content.push(imageBlock(stored.data, stored.ref.mediaType))
  }
  if (content.length === 0) {
    throw new Error('dsh-claude: the newest direct human message has no supported content')
  }
  return content
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
  readonly #attachments: AttachmentReader
  readonly #presetIdFor: (agent: Agent) => string | undefined
  readonly #drainReviewComments: (sessionId: string) => readonly ReviewComment[]
  readonly #renderMode: () => ClaudeRenderMode

  constructor(
    supervisor: ClaudeSupervisor,
    agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>,
    attachments: AttachmentReader,
    presetIdFor: (agent: Agent) => string | undefined,
    drainReviewComments: (sessionId: string) => readonly ReviewComment[] = () => [],
    renderMode: () => ClaudeRenderMode = () => DEFAULT_CLAUDE_RENDER_MODE,
  ) {
    super()
    this.#supervisor = supervisor
    this.#agents = agents
    this.#attachments = attachments
    this.#presetIdFor = presetIdFor
    this.#drainReviewComments = drainReviewComments
    this.#renderMode = renderMode
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return NO_RETRY_POLICY
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return latestClaudeModels().map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.description,
      inputModalities: ['text', 'image'],
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = claudeModelRow(model)
    const contextWindow = this.#supervisor.contextWindow(model) ?? known?.contextWindow
    return {
      provider,
      id: model,
      name: known?.name ?? `Claude Code ${model}`,
      ...(known === undefined ? {} : { description: known.description }),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      inputModalities: ['text', 'image'],
      reasoning: {
        efforts: THINKING_MODES.map(mode => ({
          id: ReasoningEffortId(mode.id),
          name: mode.name,
          description: mode.description,
        })),
      },
    }
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
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
    let prompt: ClaudePrompt
    try {
      prompt = await resolveDirectUserPrompt(options.messages, this.#attachments, options.signal)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') throw error
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { code: 'aborted', message: error instanceof Error ? error.message : 'Claude Code input resolution aborted' },
        },
      }
      return
    }
    const events = await this.#supervisor.runTurn({
      agent,
      prompt: injectReviewComments(prompt, this.#drainReviewComments(agent.id as string)),
      model: options.model,
      ...(thinkingMode === undefined ? {} : { thinkingMode }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    // The plugin renderer draws the visible transcript from the sidecar, so
    // prose and Claude tool groups share one exact ordinal stream and DSH
    // receives only an empty assistant completion anchor plus usage/lifecycle
    // metadata. The native renderer needs the opposite: every visible span
    // arrives as ordinary DSH content blocks.
    const native = this.#renderMode() === 'native'
    let pendingUsage: TokenUsage | undefined
    let completed = false
    let blockIndex = 0
    let text = ''
    /** Settle the buffered prose as one text block. Each Claude result is one
     *  block so tool activity stays ahead of the prose it explains and a
     *  background-task report can follow in a block of its own. */
    function* flushText(): Generator<StreamChunk> {
      if (text.length === 0) return
      const settled = text
      text = ''
      yield { type: 'block-start', index: blockIndex, blockType: 'text' }
      yield { type: 'text-delta', index: blockIndex, text: settled }
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: settled } }
      blockIndex += 1
    }
    try {
      for await (const event of events) {
        if (event.type === 'usage') {
          pendingUsage = tokenUsage(event.usage)
          continue
        }
        if (event.type === 'text-delta') {
          if (native) text += event.text
          continue
        }
        if (event.type === 'thinking') {
          if (!native) continue
          // Thinking settles before the prose it precedes, so nothing is
          // buffered yet; flush anyway to keep block order faithful when a
          // model interleaves the two.
          yield* flushText()
          yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: blockIndex, text: event.text }
          yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: event.text } }
          blockIndex += 1
          continue
        }
        yield* flushText()
        if (event.type === 'segment-complete') continue
        completed = true
        if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        completed = true
        yield* flushText()
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
  attachments: AttachmentReader,
  presetIdFor: (agent: Agent) => string | undefined,
  drainReviewComments: (sessionId: string) => readonly ReviewComment[] = () => [],
  renderMode: () => ClaudeRenderMode = () => DEFAULT_CLAUDE_RENDER_MODE,
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(supervisor, agents, attachments, presetIdFor, drainReviewComments, renderMode)
}
