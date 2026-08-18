import { type Options as ClaudeOptions, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { type ClaudeUsage } from './events.ts';
export declare const CLAUDE_INITIALIZATION_TIMEOUT_MS = 30000;
export declare const CLAUDE_INTERRUPT_TIMEOUT_MS = 5000;
export type ClaudeSupervisorState = 'starting' | 'idle' | 'running' | 'interrupting' | 'disconnected' | 'outcome-unknown' | 'disposed';
export interface ClaudeSupervisorConfig {
    executablePath: string;
    idleTimeoutMs: number;
    maxProcesses: number;
    defaultModel: string;
}
export type ClaudeTurnStreamEvent = {
    type: 'text-delta';
    text: string;
} | {
    type: 'usage';
    usage: ClaudeUsage;
} | {
    type: 'complete';
    text: string;
};
export interface ClaudeTurnRequest {
    agent: Agent;
    prompt: string;
    model?: string;
    signal?: AbortSignal;
}
export interface ClaudeSupervisorSnapshot {
    sessionId: string;
    claudeSessionId?: string;
    state: ClaudeSupervisorState;
    cwd: string;
    model: string;
    lastUsedAt: number;
    pid?: number;
}
export declare class ClaudeTurnBusyError extends Error {
    constructor(sessionId: string);
}
export declare class ClaudeOutcomeUnknownError extends Error {
    constructor(message?: string);
}
export declare class ClaudeProtocolError extends Error {
    constructor(message: string);
}
export declare class ClaudeProcessLimitError extends Error {
    constructor(maxProcesses: number);
}
export type ClaudeQueryFactory = (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: ClaudeOptions;
}) => Query;
export declare class ClaudeSupervisor {
    #private;
    constructor(dependencies: {
        runtime: Pick<SubprocessRuntime, 'spawn'>;
        approval: Pick<ApprovalService, 'request'>;
        config: ClaudeSupervisorConfig;
        queryFactory?: ClaudeQueryFactory;
        runDetached?: <T>(operation: () => T) => T;
    });
    snapshots(): ClaudeSupervisorSnapshot[];
    runTurn(request: ClaudeTurnRequest): Promise<AsyncIterable<ClaudeTurnStreamEvent>>;
    disposeSession(sessionId: string): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=supervisor.d.ts.map