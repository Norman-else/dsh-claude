import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { type ClaudeActivityCursor } from './events.ts';
export type ApprovalRequester = Pick<ApprovalService, 'request'>;
export interface ActivePermissionContext {
    agent: Agent;
    cursor: ClaudeActivityCursor;
    markActivity?: () => void;
    recordDenial?: (toolUseId: string) => void;
}
export type ActivePermissionContextProvider = () => ActivePermissionContext | undefined;
export declare function permissionReason(toolName: string, input: Readonly<Record<string, unknown>>, options: Parameters<CanUseTool>[2]): string;
export declare function mapApprovalOutcome(outcome: ApprovalOutcome, input: Record<string, unknown>, toolUseID: string): PermissionResult;
export declare function createPermissionBridge(approval: ApprovalRequester, activeContext: ActivePermissionContextProvider): CanUseTool;
//# sourceMappingURL=permission.d.ts.map