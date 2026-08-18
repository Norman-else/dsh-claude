function record(value) {
    return value !== null && typeof value === 'object' ? value : undefined;
}
function string(value) {
    return typeof value === 'string' ? value : undefined;
}
function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.map(item => {
        const block = record(item);
        if (block?.type === 'text')
            return string(block.text) ?? '';
        return '';
    }).join('');
}
function resultUsage(message) {
    const usage = record(message.usage);
    const normalized = {};
    if (usage !== undefined) {
        if (typeof usage.input_tokens === 'number')
            normalized.inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === 'number')
            normalized.outputTokens = usage.output_tokens;
        if (typeof usage.cache_read_input_tokens === 'number')
            normalized.cacheReadTokens = usage.cache_read_input_tokens;
        if (typeof usage.cache_creation_input_tokens === 'number')
            normalized.cacheCreationTokens = usage.cache_creation_input_tokens;
    }
    if (typeof message.total_cost_usd === 'number')
        normalized.cumulativeCostUsd = message.total_cost_usd;
    return normalized;
}
function normalizeAssistant(message) {
    const envelope = record(message.message);
    const content = envelope?.content;
    if (!Array.isArray(content))
        return [{ kind: 'protocol-error', title: 'Malformed Claude assistant message', detail: message }];
    const parentToolUseId = string(message.parent_tool_use_id);
    const normalized = [];
    for (const item of content) {
        const block = record(item);
        if (block === undefined)
            continue;
        if (block.type === 'text') {
            const text = string(block.text);
            if (text !== undefined && text.length > 0)
                normalized.push({ kind: 'assistant-text', text, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) });
        }
        else if (block.type === 'thinking') {
            const text = string(block.thinking);
            if (text !== undefined && text.length > 0)
                normalized.push({ kind: 'thinking', text, phase: 'completed', ...(parentToolUseId === undefined ? {} : { parentToolUseId }) });
        }
        else if (block.type === 'tool_use') {
            const toolUseId = string(block.id);
            const toolName = string(block.name);
            if (toolUseId !== undefined && toolName !== undefined) {
                normalized.push({
                    kind: 'tool-call',
                    toolUseId,
                    toolName,
                    input: block.input,
                    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
                });
            }
        }
    }
    return normalized;
}
function normalizeUser(message) {
    const envelope = record(message.message);
    const content = envelope?.content;
    if (!Array.isArray(content))
        return [{ kind: 'protocol-error', title: 'Malformed Claude user message', detail: message }];
    const parentToolUseId = string(message.parent_tool_use_id);
    const normalized = [];
    for (const item of content) {
        const block = record(item);
        if (block?.type !== 'tool_result')
            continue;
        const toolUseId = string(block.tool_use_id);
        if (toolUseId === undefined)
            continue;
        normalized.push({
            kind: 'tool-result',
            toolUseId,
            output: message.tool_use_result ?? block.content,
            isError: block.is_error === true,
            ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        });
    }
    return normalized;
}
function normalizeSystem(message) {
    const subtype = string(message.subtype);
    if (subtype === 'init') {
        const sessionId = string(message.session_id);
        const cliVersion = string(message.claude_code_version);
        const cwd = string(message.cwd);
        return sessionId !== undefined && cliVersion !== undefined && cwd !== undefined
            ? [{ kind: 'init', sessionId, cliVersion, cwd }]
            : [{ kind: 'protocol-error', title: 'Malformed Claude initialization message', detail: message }];
    }
    if (subtype === 'status') {
        const status = message.status;
        if (status === null)
            return [{ kind: 'status', title: 'Claude Code is ready' }];
        return [{ kind: 'status', title: `Claude Code ${String(status)}`, detail: message }];
    }
    if (subtype === 'session_state_changed') {
        return [{ kind: 'status', title: `Claude session ${String(message.state)}` }];
    }
    if (subtype === 'permission_denied') {
        const toolUseId = string(message.tool_use_id);
        const toolName = string(message.tool_name);
        if (toolUseId !== undefined && toolName !== undefined) {
            return [{
                    kind: 'permission-denied',
                    toolUseId,
                    toolName,
                    summary: string(message.message) ?? 'Claude Code denied the action',
                }];
        }
    }
    if (subtype === 'task_started') {
        return [{
                kind: 'subagent',
                title: string(message.description) ?? string(message.task_id) ?? 'Claude subagent started',
                phase: 'started',
                detail: message,
            }];
    }
    if (subtype === 'task_progress' || subtype === 'task_updated') {
        return [{
                kind: 'subagent',
                title: string(message.summary) ?? string(message.description) ?? 'Claude subagent update',
                phase: 'updated',
                detail: message,
            }];
    }
    if (subtype === 'task_notification') {
        const phase = message.status === 'failed' ? 'failed' : message.status === 'stopped' || message.status === 'cancelled' ? 'failed' : 'completed';
        return [{
                kind: 'subagent',
                title: string(message.summary) ?? string(message.task_id) ?? 'Claude subagent finished',
                phase,
                detail: message,
            }];
    }
    if (subtype === 'api_retry') {
        return [{ kind: 'warning', title: 'Claude API retry', detail: message }];
    }
    if (subtype === 'informational' || subtype === 'notification' || subtype === 'local_command_output') {
        return [{
                kind: message.level === 'warning' ? 'warning' : 'status',
                title: string(message.content) ?? string(message.text) ?? 'Claude Code notice',
                detail: message,
            }];
    }
    if (subtype?.startsWith('hook_') === true || subtype === 'plugin_install') {
        return [{ kind: 'status', title: `Claude Code ${subtype.replaceAll('_', ' ')}`, detail: message }];
    }
    if (subtype !== undefined) {
        // Preserve unknown system lifecycle evidence (background tasks, resets,
        // worker/mirror lifecycle) as a bounded activity instead of silently
        // dropping it; the activity layer redacts and bounds the detail.
        return [{ kind: 'status', title: `Claude Code ${subtype.replaceAll('_', ' ')}`, detail: message }];
    }
    return [];
}
const RESULT_ERROR_SUBTYPES = new Set([
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
]);
export function normalizeSdkMessage(message) {
    const value = message;
    if (value.type === 'stream_event') {
        const event = record(value.event);
        const parentToolUseId = string(value.parent_tool_use_id);
        if (event?.type === 'content_block_delta') {
            const delta = record(event.delta);
            if (delta?.type === 'text_delta') {
                const text = string(delta.text);
                return text === undefined ? [] : [{ kind: 'text-delta', text, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) }];
            }
            if (delta?.type === 'thinking_delta') {
                const text = string(delta.thinking);
                return text === undefined ? [] : [{ kind: 'thinking', text, phase: 'updated', ...(parentToolUseId === undefined ? {} : { parentToolUseId }) }];
            }
        }
        return [];
    }
    if (value.type === 'assistant')
        return normalizeAssistant(value);
    if (value.type === 'user')
        return normalizeUser(value);
    if (value.type === 'system')
        return normalizeSystem(value);
    if (value.type === 'result') {
        const sessionId = string(value.session_id);
        if (sessionId === undefined || (value.subtype !== 'success' && !RESULT_ERROR_SUBTYPES.has(String(value.subtype)))) {
            return [{ kind: 'protocol-error', title: 'Malformed Claude result message', detail: value }];
        }
        // A result is a success only when it is not flagged as an error. Local
        // 2.1.233 emits subtype:"success" with is_error:true for API/auth failures
        // (e.g. terminal_reason:"api_error"), so subtype alone is not authoritative.
        const success = value.subtype === 'success' && value.is_error !== true;
        const errors = Array.isArray(value.errors)
            ? value.errors.filter((item) => typeof item === 'string')
            : undefined;
        const terminalReason = string(value.terminal_reason);
        const userMessageUuid = string(value.user_message_uuid);
        const permissionDenials = Array.isArray(value.permission_denials)
            ? value.permission_denials
                .map(item => record(item))
                .filter((item) => item !== undefined)
                .map(item => {
                const toolName = string(item.tool_name);
                const toolUseId = string(item.tool_use_id);
                return toolName === undefined || toolUseId === undefined ? undefined : { toolName, toolUseId };
            })
                .filter((item) => item !== undefined)
                .slice(0, 40)
            : undefined;
        return [{
                kind: 'result',
                success,
                ...(success && typeof value.result === 'string' ? { text: value.result } : {}),
                ...(errors === undefined ? {} : { errors }),
                ...(terminalReason === undefined ? {} : { terminalReason }),
                ...(permissionDenials === undefined || permissionDenials.length === 0 ? {} : { permissionDenials }),
                usage: resultUsage(value),
                sessionId,
                ...(userMessageUuid === undefined ? {} : { userMessageUuid }),
            }];
    }
    if (value.type === 'auth_status') {
        return [{
                kind: value.error === undefined ? 'status' : 'warning',
                title: value.error === undefined ? 'Claude authentication status changed' : 'Claude authentication failed',
                detail: value.error ?? value.output,
            }];
    }
    if (value.type === 'rate_limit_event') {
        return [{ kind: 'warning', title: 'Claude rate limit status changed', detail: value.rate_limit_info }];
    }
    return [{ kind: 'unknown', title: `Unknown Claude SDK message: ${String(value.type)}`, detail: value }];
}
export function extractSdkContentText(content) {
    return contentText(content);
}
//# sourceMappingURL=sdk-messages.js.map