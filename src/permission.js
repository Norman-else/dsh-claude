import { appendClaudeActivity, boundText, safeDetail, } from "./events.js";
function denialMessage(outcome) {
    switch (outcome) {
        case 'rejected': return 'The user rejected this action in DeepSeek Harness.';
        case 'cancelled': return 'The permission request was cancelled in DeepSeek Harness.';
        case 'unavailable': return 'No DeepSeek Harness approval surface was available; the action was denied.';
        case 'allowed-once': return '';
    }
}
export function permissionReason(toolName, input, options) {
    const prompt = options.title ?? options.description ?? options.decisionReason ?? `Claude Code wants to use ${toolName}.`;
    const detail = safeDetail(input);
    return boundText(detail === undefined ? prompt : `${prompt}\nInput: ${detail}`, 1_200);
}
export function mapApprovalOutcome(outcome, input, toolUseID) {
    if (outcome === 'allowed-once') {
        return {
            behavior: 'allow',
            updatedInput: input,
            toolUseID,
            decisionClassification: 'user_temporary',
        };
    }
    return {
        behavior: 'deny',
        message: denialMessage(outcome),
        toolUseID,
        decisionClassification: 'user_reject',
    };
}
export function createPermissionBridge(approval, activeContext) {
    return async (toolName, input, options) => {
        const active = activeContext();
        if (active === undefined) {
            return {
                behavior: 'deny',
                message: 'No active DeepSeek Harness turn owns this Claude Code action.',
                toolUseID: options.toolUseID,
                decisionClassification: 'user_reject',
            };
        }
        active.markActivity?.();
        const reason = permissionReason(toolName, input, options);
        try {
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'permission',
                phase: 'started',
                toolUseId: options.toolUseID,
                toolName,
                title: options.displayName ?? toolName,
                summary: options.title ?? options.description ?? reason,
                detail: input,
            });
            const outcome = await approval.request({
                agent: active.agent,
                toolName,
                reason,
                signal: options.signal,
            });
            const result = mapApprovalOutcome(outcome, input, options.toolUseID);
            if (result.behavior === 'deny')
                active.recordDenial?.(options.toolUseID);
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'permission',
                phase: outcome === 'allowed-once' ? 'completed' : 'denied',
                toolUseId: options.toolUseID,
                toolName,
                title: options.displayName ?? toolName,
                summary: outcome === 'allowed-once' ? 'Allowed once in DeepSeek Harness' : denialMessage(outcome),
            });
            return result;
        }
        catch (error) {
            const message = options.signal.aborted
                ? 'The permission request was cancelled in DeepSeek Harness.'
                : 'DeepSeek Harness could not record or answer the permission request; the action was denied.';
            try {
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: 'permission',
                    phase: 'failed',
                    toolUseId: options.toolUseID,
                    toolName,
                    title: options.displayName ?? toolName,
                    summary: message,
                    isError: true,
                    detail: error,
                });
            }
            catch {
                // The permission path is already fail-closed; a second audit failure cannot widen it.
            }
            return {
                behavior: 'deny',
                message,
                toolUseID: options.toolUseID,
                decisionClassification: 'user_reject',
            };
        }
    };
}
//# sourceMappingURL=permission.js.map