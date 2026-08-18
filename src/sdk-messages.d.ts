import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeUsage } from './events.ts';
export type NormalizedSdkMessage = {
    kind: 'init';
    sessionId: string;
    cliVersion: string;
    cwd: string;
} | {
    kind: 'text-delta';
    text: string;
    parentToolUseId?: string;
} | {
    kind: 'assistant-text';
    text: string;
    parentToolUseId?: string;
} | {
    kind: 'thinking';
    text: string;
    phase: 'updated' | 'completed';
    parentToolUseId?: string;
} | {
    kind: 'tool-call';
    toolUseId: string;
    toolName: string;
    input: unknown;
    parentToolUseId?: string;
} | {
    kind: 'tool-result';
    toolUseId: string;
    output: unknown;
    isError: boolean;
    parentToolUseId?: string;
} | {
    kind: 'subagent';
    title: string;
    summary?: string;
    detail?: unknown;
    phase: 'started' | 'updated' | 'completed' | 'failed';
} | {
    kind: 'status';
    title: string;
    summary?: string;
    detail?: unknown;
} | {
    kind: 'warning';
    title: string;
    summary?: string;
    detail?: unknown;
} | {
    kind: 'permission-denied';
    toolUseId: string;
    toolName: string;
    summary: string;
} | {
    kind: 'result';
    success: boolean;
    text?: string;
    errors?: readonly string[];
    usage: ClaudeUsage;
    sessionId: string;
    userMessageUuid?: string;
    terminalReason?: string;
} | {
    kind: 'protocol-error';
    title: string;
    detail: unknown;
} | {
    kind: 'unknown';
    title: string;
    detail: unknown;
};
export declare function normalizeSdkMessage(message: SDKMessage): NormalizedSdkMessage[];
export declare function extractSdkContentText(content: unknown): string;
//# sourceMappingURL=sdk-messages.d.ts.map