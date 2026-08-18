import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ClaudeSupervisor } from './supervisor.ts';
export declare function extractDirectUserText(messages: GenerateOptions['messages']): string;
export declare class ClaudeCodeAdapter extends LlmAdapter {
    #private;
    constructor(supervisor: ClaudeSupervisor, agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>, presetIdFor: (agent: Agent) => string | undefined);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    listModels(): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export declare function createClaudeCodeAdapter(supervisor: ClaudeSupervisor, agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>, presetIdFor: (agent: Agent) => string | undefined): ClaudeCodeAdapter;
//# sourceMappingURL=adapter.d.ts.map