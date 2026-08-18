import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
export type ExecutableRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>;
export declare class ClaudeExecutableNotFoundError extends Error {
    readonly searched: readonly string[];
    constructor(searched: readonly string[], options?: ErrorOptions);
}
export interface ClaudeExecutableResolution {
    path: string;
    searched: readonly string[];
}
export interface ClaudeDoctorReport {
    executable: {
        status: 'found' | 'missing';
        path?: string;
        searched: readonly string[];
    };
    version: {
        status: 'ok' | 'error' | 'not-run';
        value?: string;
        message?: string;
    };
    authentication: {
        status: 'signed-in' | 'signed-out' | 'unknown' | 'not-run';
        method?: string;
        provider?: string;
        subscription?: string;
        message?: string;
    };
    handshake: 'not-run' | 'ok' | 'error';
}
export declare function resolveClaudeExecutable(runtime: ExecutableRuntime, configuredPath?: string, signal?: AbortSignal): Promise<ClaudeExecutableResolution>;
export declare function parseClaudeVersion(output: string): string | undefined;
export declare function probeClaudeVersion(runtime: ExecutableRuntime, executable: string, cwd: string, signal?: AbortSignal): Promise<string>;
export declare function probeClaudeAuthentication(runtime: ExecutableRuntime, executable: string, cwd: string, signal?: AbortSignal): Promise<ClaudeDoctorReport['authentication']>;
export declare function runClaudeDoctor(runtime: ExecutableRuntime, options: {
    configuredPath?: string;
    cwd: string;
    signal?: AbortSignal;
}): Promise<ClaudeDoctorReport>;
//# sourceMappingURL=executable.d.ts.map