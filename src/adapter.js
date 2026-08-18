import { LlmAdapter, } from '@deepseek-ai/dsh-llm';
import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER } from "./constants.js";
const MODELS = [
    { id: 'default', name: 'Claude Code Default', description: 'Use the model selected by Claude Code configuration.' },
    { id: 'sonnet', name: 'Claude Sonnet', description: 'Ask Claude Code to use the Sonnet alias.' },
    { id: 'opus', name: 'Claude Opus', description: 'Ask Claude Code to use the Opus alias.' },
    { id: 'haiku', name: 'Claude Haiku', description: 'Ask Claude Code to use the Haiku alias.' },
];
const NO_RETRY_POLICY = Object.freeze({
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: Object.freeze([]),
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
});
export function extractDirectUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user' || message.source.kind !== 'user')
            continue;
        const text = message.content
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('\n')
            .trim();
        if (text.length > 0)
            return text;
        if (message.content.some(block => block.type === 'image')) {
            throw new Error('dsh-claude-code: image-only prompts are not supported in v0.1; include a text prompt');
        }
    }
    throw new Error('dsh-claude-code: no direct human text was present in this model step');
}
function tokenUsage(usage) {
    const normalized = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
    };
    if (usage.cacheReadTokens !== undefined)
        normalized.cacheReadTokens = usage.cacheReadTokens;
    if (usage.cacheCreationTokens !== undefined)
        normalized.cacheWriteTokens = usage.cacheCreationTokens;
    return normalized;
}
function resolveAgent(agents, options) {
    const initiator = agents.currentInitiator();
    if (initiator !== undefined)
        return initiator;
    if (options.sessionId !== undefined) {
        const agent = agents.get(options.sessionId);
        if (agent !== undefined)
            return agent;
    }
    throw new Error('dsh-claude-code: the model request has no live owning DSH agent');
}
export class ClaudeCodeAdapter extends LlmAdapter {
    #supervisor;
    #agents;
    #presetIdFor;
    constructor(supervisor, agents, presetIdFor) {
        super();
        this.#supervisor = supervisor;
        this.#agents = agents;
        this.#presetIdFor = presetIdFor;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Claude Code CLI' };
    }
    providerRetryPolicy() {
        return NO_RETRY_POLICY;
    }
    async listModels() {
        return MODELS.map(model => ({
            provider: CLAUDE_CODE_PROVIDER,
            id: model.id,
            name: model.name,
            description: model.description,
            inputModalities: ['text'],
        }));
    }
    async resolveModel(provider, model) {
        const known = MODELS.find(item => item.id === model);
        return {
            provider,
            id: model,
            name: known?.name ?? `Claude Code ${model}`,
            ...(known === undefined ? {} : { description: known.description }),
            inputModalities: ['text'],
        };
    }
    async *stream(options) {
        if (options.purpose !== undefined) {
            throw new Error(`dsh-claude-code: auxiliary ${options.purpose} calls are not routed into the Claude session`);
        }
        const agent = resolveAgent(this.#agents, options);
        if (this.#presetIdFor(agent) !== CLAUDE_CODE_PRESET_ID) {
            throw new Error(`dsh-claude-code: provider ${CLAUDE_CODE_PROVIDER} is available only to the ${CLAUDE_CODE_PRESET_ID} preset`);
        }
        const prompt = extractDirectUserText(options.messages);
        const events = await this.#supervisor.runTurn({
            agent,
            prompt,
            model: options.model,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        let started = false;
        let text = '';
        let pendingUsage;
        let completed = false;
        try {
            for await (const event of events) {
                if (event.type === 'text-delta') {
                    if (!started) {
                        started = true;
                        yield { type: 'block-start', index: 0, blockType: 'text' };
                    }
                    text += event.text;
                    yield { type: 'text-delta', index: 0, text: event.text };
                }
                else if (event.type === 'usage') {
                    pendingUsage = tokenUsage(event.usage);
                }
                else {
                    completed = true;
                    if (started)
                        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
                    if (pendingUsage !== undefined)
                        yield { type: 'usage', usage: pendingUsage };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            }
        }
        catch (error) {
            if (error.name === 'AbortError') {
                completed = true;
                if (started)
                    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
                yield {
                    type: 'finish',
                    reason: {
                        kind: 'aborted',
                        failure: { code: 'aborted', message: error instanceof Error ? error.message : 'Claude Code turn aborted' },
                    },
                };
                return;
            }
            throw error;
        }
        if (!completed)
            throw new Error('dsh-claude-code: Claude turn stream ended without a result');
    }
}
export function createClaudeCodeAdapter(supervisor, agents, presetIdFor) {
    return new ClaudeCodeAdapter(supervisor, agents, presetIdFor);
}
//# sourceMappingURL=adapter.js.map