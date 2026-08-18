import { randomUUID } from 'node:crypto';
import { query as claudeQuery, } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from "./async-queue.js";
import { appendClaudeActivity, appendClaudeSessionBinding, currentClaudeActivityCursor, latestClaudeSessionBinding, } from "./events.js";
import { createPermissionBridge } from "./permission.js";
import { normalizeSdkMessage } from "./sdk-messages.js";
import { createManagedClaudeSpawner } from "./spawn.js";
export const CLAUDE_INITIALIZATION_TIMEOUT_MS = 30_000;
export const CLAUDE_INTERRUPT_TIMEOUT_MS = 5_000;
export class ClaudeTurnBusyError extends Error {
    constructor(sessionId) {
        super(`Claude Code session ${sessionId} already has an active or interrupting turn`);
        this.name = 'ClaudeTurnBusyError';
    }
}
export class ClaudeOutcomeUnknownError extends Error {
    constructor(message = 'Claude Code exited after activity; side-effect outcome is unknown and the prompt was not replayed') {
        super(message);
        this.name = 'ClaudeOutcomeUnknownError';
    }
}
export class ClaudeProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ClaudeProtocolError';
    }
}
export class ClaudeProcessLimitError extends Error {
    constructor(maxProcesses) {
        super(`Claude Code process limit reached (${maxProcesses}) and no idle session can be evicted`);
        this.name = 'ClaudeProcessLimitError';
    }
}
function abortFailure() {
    const error = new Error('Claude Code turn aborted');
    error.name = 'AbortError';
    return error;
}
function signalAborted(signal) {
    return signal?.aborted === true;
}
async function withTimeout(operation, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function sdkUserMessage(prompt, uuid) {
    return {
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        uuid,
    };
}
function usageSummary(usage) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    return `${input} input / ${output} output tokens`;
}
function errorSummary(error) {
    return error instanceof Error ? error.message : String(error);
}
export class ClaudeSupervisor {
    #entries = new Map();
    #runtime;
    #approval;
    #config;
    #queryFactory;
    #runDetached;
    #disposed = false;
    #admissionGate = Promise.resolve();
    constructor(dependencies) {
        this.#runtime = dependencies.runtime;
        this.#approval = dependencies.approval;
        this.#config = dependencies.config;
        this.#queryFactory = dependencies.queryFactory ?? (params => claudeQuery(params));
        this.#runDetached = dependencies.runDetached ?? (operation => operation());
    }
    snapshots() {
        return [...this.#entries.values()].map(entry => ({
            sessionId: entry.sessionId,
            ...(entry.claudeSessionId === undefined ? {} : { claudeSessionId: entry.claudeSessionId }),
            state: entry.state,
            cwd: entry.cwd,
            model: entry.model,
            lastUsedAt: entry.lastUsedAt,
            ...(entry.process === undefined ? {} : { pid: entry.process.handle.pid }),
        }));
    }
    runTurn(request) {
        const operation = this.#admissionGate.then(() => this.#runTurnAdmitted(request));
        this.#admissionGate = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async #runTurnAdmitted(request) {
        if (this.#disposed)
            throw new Error('dsh-claude-code: supervisor is disposed');
        if (signalAborted(request.signal))
            throw abortFailure();
        const sessionId = request.agent.id;
        let entry = this.#entries.get(sessionId);
        if (entry?.state === 'disposed' || entry?.state === 'disconnected' || entry?.state === 'outcome-unknown') {
            this.#entries.delete(sessionId);
            await this.#disposeEntry(entry);
            entry = undefined;
        }
        if (entry === undefined) {
            await this.#makeRoom();
            entry = this.#createEntry(request.agent, request.model ?? this.#config.defaultModel);
            this.#entries.set(sessionId, entry);
            this.#armInitializationTimer(entry);
        }
        if (entry.ownerAgent !== request.agent) {
            throw new Error(`dsh-claude-code: live agent identity changed for session ${sessionId}`);
        }
        if (entry.active !== undefined || entry.state === 'interrupting')
            throw new ClaudeTurnBusyError(sessionId);
        if (entry.idleTimer !== undefined) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;
        }
        const model = request.model ?? this.#config.defaultModel;
        if (model !== entry.model) {
            await entry.query.setModel(model === 'default' ? undefined : model);
            entry.model = model;
        }
        const promptUuid = randomUUID();
        const active = {
            agent: request.agent,
            cursor: currentClaudeActivityCursor(request.agent.session.events),
            output: new AsyncQueue(),
            promptUuid,
            sawActivity: false,
            sawTextDelta: false,
            text: '',
            thinking: '',
            aborted: false,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        entry.active = active;
        entry.state = 'running';
        entry.lastUsedAt = Date.now();
        try {
            await appendClaudeActivity(request.agent, active.cursor, {
                kind: 'status',
                phase: 'started',
                title: 'Claude Code turn started',
            });
        }
        catch (error) {
            active.output.fail(error);
            entry.active = undefined;
            if (this.#entries.get(sessionId) === entry)
                this.#entries.delete(sessionId);
            await this.#disposeEntry(entry);
            throw error;
        }
        if (signalAborted(request.signal)) {
            active.aborted = true;
            active.output.fail(abortFailure());
            await appendClaudeActivity(request.agent, active.cursor, {
                kind: 'status',
                phase: 'failed',
                title: 'Claude Code turn cancelled before submission',
            });
            entry.active = undefined;
            entry.state = 'idle';
            entry.lastUsedAt = Date.now();
            this.#armIdleTimer(entry);
            return active.output;
        }
        if (request.signal !== undefined) {
            const abortListener = () => { void this.#interrupt(entry); };
            active.abortListener = abortListener;
            request.signal.addEventListener('abort', abortListener, { once: true });
        }
        entry.input.push(sdkUserMessage(request.prompt, promptUuid));
        return active.output;
    }
    async disposeSession(sessionId) {
        const entry = this.#entries.get(sessionId);
        if (entry === undefined)
            return;
        this.#entries.delete(sessionId);
        await this.#disposeEntry(entry);
    }
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        const entries = [...this.#entries.values()];
        this.#entries.clear();
        await Promise.allSettled(entries.map(entry => this.#disposeEntry(entry)));
    }
    async #makeRoom() {
        if (this.#entries.size < this.#config.maxProcesses)
            return;
        const idle = [...this.#entries.values()]
            .filter(entry => entry.active === undefined && entry.state === 'idle')
            .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (idle === undefined)
            throw new ClaudeProcessLimitError(this.#config.maxProcesses);
        this.#entries.delete(idle.sessionId);
        await this.#disposeEntry(idle);
    }
    #createEntry(agent, model) {
        const sessionId = agent.id;
        const cwd = agent.session.header.cwd ?? process.cwd();
        const input = new AsyncQueue();
        const lifetime = new AbortController();
        const binding = latestClaudeSessionBinding(agent.session.events);
        const entry = {
            sessionId,
            ownerAgent: agent,
            cwd,
            model,
            state: 'starting',
            lastUsedAt: Date.now(),
            input,
            lifetime,
            claudeSessionId: binding?.claudeSessionId,
            expectedResume: binding?.claudeSessionId,
            initialized: false,
            initTimer: undefined,
            idleTimer: undefined,
        };
        const canUseTool = createPermissionBridge(this.#approval, () => {
            const active = entry.active;
            return active === undefined ? undefined : {
                agent: active.agent,
                cursor: active.cursor,
                markActivity: () => { active.sawActivity = true; },
            };
        });
        const options = {
            pathToClaudeCodeExecutable: this.#config.executablePath,
            cwd,
            settingSources: ['user', 'project', 'local'],
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            tools: { type: 'preset', preset: 'claude_code' },
            includePartialMessages: true,
            permissionMode: 'default',
            canUseTool,
            abortController: lifetime,
            spawnClaudeCodeProcess: createManagedClaudeSpawner(this.#runtime, this.#config.executablePath, process => {
                entry.process = process;
            }),
            ...(binding === undefined ? {} : { resume: binding.claudeSessionId }),
            ...(model === 'default' ? {} : { model }),
        };
        entry.query = this.#queryFactory({ prompt: input, options });
        entry.pump = this.#runDetached(() => this.#pump(entry));
        return entry;
    }
    async #pump(entry) {
        try {
            for await (const sdkMessage of entry.query) {
                for (const message of normalizeSdkMessage(sdkMessage)) {
                    await this.#handleMessage(entry, message);
                }
            }
            if (entry.state !== 'disposed')
                await this.#handleDisconnect(entry, new Error('Claude Code stream ended'));
        }
        catch (error) {
            if (entry.state !== 'disposed')
                await this.#handleDisconnect(entry, error);
        }
    }
    async #handleMessage(entry, message) {
        if (message.kind === 'init') {
            if (entry.initialized) {
                throw new ClaudeProtocolError('Claude Code sent a duplicate initialization message');
            }
            if (entry.expectedResume !== undefined && message.sessionId !== entry.expectedResume) {
                throw new ClaudeProtocolError(`Claude Code resumed unexpected session ${message.sessionId}; expected ${entry.expectedResume}`);
            }
            if (message.cwd !== entry.cwd) {
                throw new ClaudeProtocolError(`Claude Code initialized in unexpected cwd ${message.cwd}; expected ${entry.cwd}`);
            }
            if (entry.initTimer !== undefined) {
                clearTimeout(entry.initTimer);
                entry.initTimer = undefined;
            }
            entry.initialized = true;
            entry.claudeSessionId = message.sessionId;
            entry.state = entry.active === undefined ? 'idle' : 'running';
            await appendClaudeSessionBinding(entry.ownerAgent, {
                claudeSessionId: message.sessionId,
                cliVersion: message.cliVersion,
                cwd: message.cwd,
            });
            return;
        }
        const active = entry.active;
        if (active === undefined)
            return;
        if (message.kind === 'result') {
            if (entry.claudeSessionId === undefined) {
                throw new ClaudeProtocolError('Claude Code sent a result before initialization');
            }
            if (message.sessionId !== entry.claudeSessionId) {
                throw new ClaudeProtocolError(`Claude Code result session ${message.sessionId} does not match ${entry.claudeSessionId}`);
            }
            if (message.userMessageUuid !== undefined && message.userMessageUuid !== active.promptUuid) {
                throw new ClaudeProtocolError(`Claude Code result for user message ${message.userMessageUuid} does not match active request ${active.promptUuid}`);
            }
            await this.#completeTurn(entry, active, message);
            return;
        }
        if (message.kind === 'protocol-error') {
            throw new ClaudeProtocolError(`${message.title}: ${JSON.stringify(message.detail).slice(0, 1_000)}`);
        }
        active.sawActivity = true;
        switch (message.kind) {
            case 'text-delta':
                if (message.parentToolUseId !== undefined)
                    return;
                active.sawTextDelta = true;
                active.text += message.text;
                active.output.push({ type: 'text-delta', text: message.text });
                return;
            case 'assistant-text':
                if (message.parentToolUseId !== undefined)
                    return;
                if (!active.sawTextDelta) {
                    active.text += message.text;
                    active.output.push({ type: 'text-delta', text: message.text });
                }
                return;
            case 'thinking':
                if (message.parentToolUseId !== undefined)
                    return;
                if (message.phase === 'updated') {
                    active.thinking += message.text;
                    return;
                }
                active.thinking = message.text;
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: 'thinking',
                    phase: 'completed',
                    title: 'Claude thinking',
                    summary: message.text,
                });
                return;
            case 'tool-call':
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: message.parentToolUseId === undefined ? 'tool-call' : 'subagent',
                    phase: 'started',
                    toolUseId: message.toolUseId,
                    toolName: message.toolName,
                    title: message.toolName,
                    summary: message.parentToolUseId === undefined ? `Claude called ${message.toolName}` : `Subagent called ${message.toolName}`,
                    detail: message.input,
                });
                return;
            case 'tool-result':
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: message.parentToolUseId === undefined ? 'tool-result' : 'subagent',
                    phase: message.isError ? 'failed' : 'completed',
                    toolUseId: message.toolUseId,
                    title: message.isError ? 'Tool failed' : 'Tool completed',
                    detail: message.output,
                    isError: message.isError,
                });
                return;
            case 'subagent':
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: 'subagent',
                    phase: message.phase,
                    title: message.title,
                    summary: message.summary,
                    detail: message.detail,
                    isError: message.phase === 'failed',
                });
                return;
            case 'status':
            case 'warning':
            case 'unknown':
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: message.kind === 'status' ? 'status' : 'warning',
                    phase: 'updated',
                    title: message.title,
                    ...('summary' in message ? { summary: message.summary } : {}),
                    ...('detail' in message ? { detail: message.detail } : {}),
                });
                return;
            case 'permission-denied':
                await appendClaudeActivity(active.agent, active.cursor, {
                    kind: 'permission',
                    phase: 'denied',
                    toolUseId: message.toolUseId,
                    toolName: message.toolName,
                    title: message.toolName,
                    summary: message.summary,
                });
                return;
        }
    }
    async #completeTurn(entry, active, result) {
        if (entry.active !== active)
            return;
        if (active.signal !== undefined && active.abortListener !== undefined) {
            active.signal.removeEventListener('abort', active.abortListener);
        }
        if (active.aborted) {
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'status',
                phase: 'failed',
                title: 'Claude Code turn cancelled',
            });
            entry.active = undefined;
            entry.state = 'idle';
            entry.lastUsedAt = Date.now();
            this.#armIdleTimer(entry);
            return;
        }
        if (result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined || result.usage.cumulativeCostUsd !== undefined) {
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'usage',
                phase: 'completed',
                title: 'Claude usage',
                summary: usageSummary(result.usage),
                usage: result.usage,
            });
            active.output.push({ type: 'usage', usage: result.usage });
        }
        if (!result.success) {
            const message = result.errors?.join('\n') || 'Claude Code failed the turn';
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'error',
                phase: 'failed',
                title: 'Claude Code turn failed',
                summary: message,
                isError: true,
            });
            active.output.fail(new Error(message));
        }
        else {
            if (!active.sawTextDelta && active.text.length === 0 && result.text !== undefined) {
                active.text = result.text;
                active.output.push({ type: 'text-delta', text: result.text });
            }
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'status',
                phase: 'completed',
                title: 'Claude Code turn completed',
            });
            active.output.push({ type: 'complete', text: active.text });
            active.output.close();
        }
        entry.active = undefined;
        entry.state = 'idle';
        entry.lastUsedAt = Date.now();
        this.#armIdleTimer(entry);
    }
    async #interrupt(entry) {
        const active = entry.active;
        if (active === undefined || entry.state === 'interrupting')
            return;
        entry.state = 'interrupting';
        active.aborted = true;
        active.output.fail(abortFailure());
        let interruptError;
        try {
            const receipt = await withTimeout(entry.query.interrupt(), CLAUDE_INTERRUPT_TIMEOUT_MS, 'Claude Code interrupt');
            const queued = receipt?.still_queued ?? [];
            if (queued.includes(active.promptUuid)) {
                throw new Error(`Claude Code interrupt left submitted prompt ${active.promptUuid} queued`);
            }
        }
        catch (error) {
            interruptError = error;
        }
        try {
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'status',
                phase: 'failed',
                title: interruptError === undefined ? 'Claude Code turn cancelled' : 'Claude Code cancelled; process entry reset',
                ...(interruptError === undefined ? {} : { summary: errorSummary(interruptError) }),
            });
        }
        catch {
            // The active output is already aborted; process cleanup cannot wait for audit availability.
        }
        if (this.#entries.get(entry.sessionId) === entry)
            this.#entries.delete(entry.sessionId);
        await this.#disposeEntry(entry);
    }
    async #handleDisconnect(entry, error) {
        const active = entry.active;
        const stderr = entry.process?.stderrTail();
        if (active !== undefined) {
            if (active.signal !== undefined && active.abortListener !== undefined) {
                active.signal.removeEventListener('abort', active.abortListener);
            }
            const unknown = active.sawActivity;
            entry.state = unknown ? 'outcome-unknown' : 'disconnected';
            const failure = unknown
                ? new ClaudeOutcomeUnknownError(stderr === undefined || stderr.length === 0 ? undefined : `Claude Code exited after activity; outcome unknown. ${stderr}`)
                : new Error(stderr === undefined || stderr.length === 0 ? errorSummary(error) : stderr);
            await appendClaudeActivity(active.agent, active.cursor, {
                kind: 'error',
                phase: 'failed',
                title: unknown ? 'Claude Code outcome unknown' : 'Claude Code disconnected',
                summary: failure.message,
                isError: true,
                detail: error,
            }).catch(() => undefined);
            active.output.fail(failure);
            entry.active = undefined;
        }
        else {
            entry.state = 'disconnected';
        }
        this.#entries.delete(entry.sessionId);
        await this.#disposeEntry(entry);
    }
    #armInitializationTimer(entry) {
        const timer = setTimeout(() => {
            if (entry.state !== 'starting' || entry.initialized)
                return;
            void this.#handleDisconnect(entry, new Error('Claude Code initialization timed out'));
        }, CLAUDE_INITIALIZATION_TIMEOUT_MS);
        timer.unref?.();
        entry.initTimer = timer;
    }
    #armIdleTimer(entry) {
        if (this.#config.idleTimeoutMs <= 0)
            return;
        const timer = setTimeout(() => {
            if (entry.active !== undefined || entry.state !== 'idle')
                return;
            this.#entries.delete(entry.sessionId);
            void this.#disposeEntry(entry);
        }, this.#config.idleTimeoutMs);
        timer.unref?.();
        entry.idleTimer = timer;
    }
    async #disposeEntry(entry) {
        if (entry.state === 'disposed')
            return;
        if (entry.idleTimer !== undefined)
            clearTimeout(entry.idleTimer);
        if (entry.initTimer !== undefined)
            clearTimeout(entry.initTimer);
        entry.state = 'disposed';
        entry.input.discard(abortFailure());
        entry.query.close();
        entry.lifetime.abort();
        if (entry.active !== undefined)
            entry.active.output.fail(abortFailure());
        entry.process?.kill('SIGTERM');
        if (entry.process !== undefined) {
            try {
                await entry.process.handle.waitForExit(AbortSignal.timeout(5_000));
            }
            catch {
                // The DSH subprocess owner still holds the tree and will finish escalation.
            }
        }
    }
}
//# sourceMappingURL=supervisor.js.map