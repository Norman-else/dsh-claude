import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { type SubprocessHandle, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
export declare const CLAUDE_PROCESS_GRACE_MS = 2000;
export declare const CLAUDE_STDERR_TAIL_BYTES: number;
export declare function scrubClaudeSpawnEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv;
export declare class ManagedClaudeProcess extends EventEmitter implements SpawnedProcess {
    #private;
    readonly stdin: Writable;
    readonly stdout: Readable;
    readonly handle: SubprocessHandle;
    constructor(handle: SubprocessHandle);
    get killed(): boolean;
    get exitCode(): number | null;
    get signalCode(): NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean;
    stderrTail(): string;
}
export type SpawnObserver = (process: ManagedClaudeProcess, options: SpawnOptions) => void;
export declare function createManagedClaudeSpawner(runtime: Pick<SubprocessRuntime, 'spawn'>, executablePath: string, observe?: SpawnObserver): (options: SpawnOptions) => SpawnedProcess;
//# sourceMappingURL=spawn.d.ts.map