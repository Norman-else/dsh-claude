import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
export type ClaudeActivityKind = 'status' | 'thinking' | 'tool-call' | 'tool-result' | 'permission' | 'subagent' | 'usage' | 'warning' | 'error';
export type ClaudeActivityPhase = 'started' | 'updated' | 'completed' | 'denied' | 'failed';
export interface ClaudeUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    cumulativeCostUsd?: number;
}
export interface ClaudeSessionBoundEvent {
    claudeSessionId: string;
    cliVersion?: string;
    sdkVersion: string;
    cwd: string;
}
export interface ClaudeActivityEvent {
    turn: number;
    step: number;
    ordinal: number;
    kind: ClaudeActivityKind;
    phase?: ClaudeActivityPhase;
    toolUseId?: string;
    toolName?: string;
    title?: string;
    summary?: string;
    detail?: string;
    isError?: boolean;
    usage?: ClaudeUsage;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'claude-code/session-bound': ClaudeSessionBoundEvent;
        'claude-code/activity': ClaudeActivityEvent;
    }
}
export declare function installClaudeEventVocabulary(): void;
export declare function boundText(value: string, maxChars: number): string;
export declare function redactText(value: string, maxChars?: number): string;
export declare function redactValue(value: unknown, depth?: number, seen?: WeakSet<object>): unknown;
export declare function safeDetail(value: unknown): string | undefined;
export declare function normalizeActivity(activity: Omit<ClaudeActivityEvent, 'summary' | 'detail'> & {
    summary?: unknown;
    detail?: unknown;
}): ClaudeActivityEvent;
export interface ClaudeActivityCursor {
    turn: number;
    step: number;
    nextOrdinal: number;
}
export declare function currentClaudeActivityCursor(events: readonly SessionEvent[]): ClaudeActivityCursor;
export type ClaudeActivityInput = Omit<ClaudeActivityEvent, 'turn' | 'step' | 'ordinal' | 'summary' | 'detail'> & {
    summary?: unknown;
    detail?: unknown;
};
export declare function appendClaudeActivity(agent: Agent, cursor: ClaudeActivityCursor, activity: ClaudeActivityInput): Promise<ClaudeActivityEvent>;
export declare function appendClaudeSessionBinding(agent: Agent, binding: Omit<ClaudeSessionBoundEvent, 'sdkVersion'> & {
    sdkVersion?: string;
}): Promise<ClaudeSessionBoundEvent>;
export declare function latestClaudeSessionBinding(events: readonly SessionEvent[]): ClaudeSessionBoundEvent | undefined;
//# sourceMappingURL=events.d.ts.map