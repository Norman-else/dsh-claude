import { CLAUDE_DOCTOR_PATH } from "./constants.js";
import { runClaudeDoctor } from "./executable.js";
import { redactText } from "./events.js";
function trustedRequest(req) {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1')
        return false;
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site')
        return false;
    const host = req.headers.host;
    if (host === undefined)
        return false;
    const authority = /^(?:127\.0\.0\.1|\[?::1\]?|localhost)(?::\d+)?$/i;
    if (!authority.test(host))
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        const originUrl = new URL(origin);
        return originUrl.host === host && authority.test(originUrl.host);
    }
    catch {
        return false;
    }
}
function json(res, status, value) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(value));
}
export const CLAUDE_DOCTOR_PROBE_TIMEOUT_MS = 15_000;
function safeMessage(error) {
    return redactText(error instanceof Error ? error.message : String(error), 1_000);
}
export function registerClaudeDoctorRoutes(ctx, runtime, supervisor, config, resolutionError) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: CLAUDE_DOCTOR_PATH,
        handler: async (req, res) => {
            if (req.method !== 'GET')
                return json(res, 405, { error: 'method not allowed' });
            if (!trustedRequest(req))
                return json(res, 403, { error: 'forbidden' });
            try {
                if (resolutionError !== undefined) {
                    return json(res, 200, {
                        executable: {
                            status: 'missing',
                            searched: config.executablePath.length > 0 ? [config.executablePath] : ['claude', '~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
                        },
                        version: { status: 'not-run' },
                        authentication: { status: 'not-run' },
                        handshake: 'not-run',
                        message: safeMessage(resolutionError),
                        limits: {
                            idleTimeoutMs: config.idleTimeoutMs,
                            maxProcesses: config.maxProcesses,
                        },
                        processes: { count: 0, active: 0 },
                    });
                }
                const report = await runClaudeDoctor(runtime, {
                    configuredPath: config.executablePath,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(CLAUDE_DOCTOR_PROBE_TIMEOUT_MS),
                });
                const processes = supervisor.snapshots();
                if (processes.some(process => process.claudeSessionId !== undefined))
                    report.handshake = 'ok';
                json(res, 200, {
                    ...report,
                    limits: {
                        idleTimeoutMs: config.idleTimeoutMs,
                        maxProcesses: config.maxProcesses,
                    },
                    processes: {
                        count: processes.length,
                        active: processes.filter(process => process.state === 'running' || process.state === 'starting').length,
                    },
                });
            }
            catch (error) {
                json(res, 500, { error: safeMessage(error) });
            }
        },
    }), 'dsh-claude-code: Doctor route');
}
//# sourceMappingURL=doctor-routes.js.map