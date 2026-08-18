import z from '@deepseek-ai/schemastery';
import { CLAUDE_CODE_PROVIDER } from "./constants.js";
import { installClaudeEventVocabulary } from "./events.js";
import { resolveClaudeExecutable } from "./executable.js";
import { ClaudeSupervisor } from "./supervisor.js";
import { createClaudeCodeAdapter } from "./adapter.js";
import { ensureManagedPreset } from "./preset-installer.js";
import { registerClaudeDoctorRoutes } from "./doctor-routes.js";
export const name = 'llm-claude-code-cli';
export const inject = ['llm', 'agents', 'agentPresets', 'subprocess', 'approval'];
export const Config = z.object({
    executablePath: z.string().default(''),
    model: z.string().default('default'),
    idleTimeoutMs: z.number().min(1_000).max(2_147_483_647).default(30 * 60 * 1_000),
    maxProcesses: z.number().step(1).min(1).default(4),
});
export async function apply(ctx, config) {
    installClaudeEventVocabulary();
    await ensureManagedPreset();
    const supervisorConfig = {
        executablePath: '',
        defaultModel: config.model ?? 'default',
        idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1_000,
        maxProcesses: config.maxProcesses ?? 4,
    };
    const supervisor = new ClaudeSupervisor({
        runtime: ctx.subprocess,
        approval: ctx.approval,
        config: supervisorConfig,
        runDetached: operation => ctx.agents.withoutInitiator(operation),
    });
    let resolutionError;
    try {
        const resolution = await resolveClaudeExecutable(ctx.subprocess, config.executablePath === undefined || config.executablePath.length === 0
            ? undefined
            : config.executablePath);
        supervisorConfig.executablePath = resolution.path;
        ctx.llm.registerAdapter([CLAUDE_CODE_PROVIDER], createClaudeCodeAdapter(supervisor, ctx.agents, agent => ctx.agentPresets.composedPreset(agent.ctx)));
    }
    catch (error) {
        resolutionError = error;
    }
    ctx.on('agent/disposed', async ({ agent }) => {
        await supervisor.disposeSession(agent.id);
    });
    ctx.effect(() => () => supervisor.dispose(), 'dsh-claude-code: process supervisor');
    ctx.inject(['webServer'], webCtx => {
        registerClaudeDoctorRoutes(webCtx, webCtx.subprocess, supervisor, supervisorConfig, resolutionError);
    });
}
//# sourceMappingURL=index.js.map