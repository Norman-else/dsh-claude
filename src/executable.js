import { homedir } from 'node:os';
import { join } from 'node:path';
const VERSION_PATTERN = /(?:Claude Code\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i;
const MAX_PROBE_STDOUT = 64 * 1024;
const MAX_PROBE_STDERR = 8 * 1024;
export class ClaudeExecutableNotFoundError extends Error {
    searched;
    constructor(searched, options) {
        super(`Claude Code executable not found. Searched: ${searched.join(', ')}`, options);
        this.name = 'ClaudeExecutableNotFoundError';
        this.searched = [...searched];
    }
}
function fallbackCandidates() {
    if (process.platform !== 'darwin')
        return [];
    return [
        join(homedir(), '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
    ];
}
function abortError(error) {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
export async function resolveClaudeExecutable(runtime, configuredPath, signal) {
    const searched = [];
    const candidates = configuredPath === undefined
        ? ['claude', ...fallbackCandidates()]
        : [configuredPath];
    if (configuredPath !== undefined && !configuredPath.startsWith('/')) {
        throw new Error(`Claude Code executable path must be absolute: ${configuredPath}`);
    }
    let lastError;
    for (const candidate of candidates) {
        if (searched.includes(candidate))
            continue;
        searched.push(candidate);
        try {
            const path = await runtime.resolveExecutable(candidate, undefined, signal);
            return { path, searched };
        }
        catch (error) {
            if (abortError(error) || signal?.aborted === true)
                throw error;
            lastError = error;
        }
    }
    throw new ClaudeExecutableNotFoundError(searched, lastError === undefined ? undefined : { cause: lastError });
}
async function collect(handle) {
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? '';
    const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
    return { ...outcome, stdout, stderr };
}
async function runProbe(runtime, executable, args, cwd, signal) {
    return collect(runtime.spawn({
        argv: [executable, ...args],
        cwd,
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_PROBE_STDOUT },
            stderr: { maxBytes: MAX_PROBE_STDERR },
        },
        graceMs: 2_000,
        ...(signal === undefined ? {} : { signal }),
        env: {},
    }));
}
export function parseClaudeVersion(output) {
    return VERSION_PATTERN.exec(output)?.[1];
}
export async function probeClaudeVersion(runtime, executable, cwd, signal) {
    const result = await runProbe(runtime, executable, ['--version'], cwd, signal);
    const version = parseClaudeVersion(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode !== 0 || version === undefined) {
        throw new Error(`Claude Code version probe failed (${result.exitCode ?? result.signal ?? 'unknown exit'})`);
    }
    return version;
}
export async function probeClaudeAuthentication(runtime, executable, cwd, signal) {
    const result = await runProbe(runtime, executable, ['auth', 'status', '--json'], cwd, signal);
    if (result.exitCode !== 0) {
        return { status: 'unknown', message: 'Claude authentication status command failed' };
    }
    try {
        const value = JSON.parse(result.stdout);
        const report = {
            status: value.loggedIn === true ? 'signed-in' : value.loggedIn === false ? 'signed-out' : 'unknown',
        };
        if (typeof value.authMethod === 'string')
            report.method = value.authMethod.slice(0, 100);
        if (typeof value.apiProvider === 'string')
            report.provider = value.apiProvider.slice(0, 100);
        if (typeof value.subscriptionType === 'string')
            report.subscription = value.subscriptionType.slice(0, 100);
        return report;
    }
    catch {
        return { status: 'unknown', message: 'Claude authentication status was not valid JSON' };
    }
}
export async function runClaudeDoctor(runtime, options) {
    let resolution;
    try {
        resolution = await resolveClaudeExecutable(runtime, options.configuredPath, options.signal);
    }
    catch (error) {
        if (error instanceof ClaudeExecutableNotFoundError) {
            return {
                executable: { status: 'missing', searched: error.searched },
                version: { status: 'not-run' },
                authentication: { status: 'not-run' },
                handshake: 'not-run',
            };
        }
        throw error;
    }
    const report = {
        executable: { status: 'found', path: resolution.path, searched: resolution.searched },
        version: { status: 'not-run' },
        authentication: { status: 'not-run' },
        handshake: 'not-run',
    };
    try {
        report.version = {
            status: 'ok',
            value: await probeClaudeVersion(runtime, resolution.path, options.cwd, options.signal),
        };
    }
    catch (error) {
        report.version = {
            status: 'error',
            message: error instanceof Error ? error.message : 'Version probe failed',
        };
    }
    try {
        report.authentication = await probeClaudeAuthentication(runtime, resolution.path, options.cwd, options.signal);
    }
    catch (error) {
        report.authentication = {
            status: 'unknown',
            message: error instanceof Error ? error.message : 'Authentication probe failed',
        };
    }
    return report;
}
//# sourceMappingURL=executable.js.map