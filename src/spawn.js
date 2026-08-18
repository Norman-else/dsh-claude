import { EventEmitter } from 'node:events';
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN, } from '@deepseek-ai/dsh-subprocess';
export const CLAUDE_PROCESS_GRACE_MS = 2_000;
export const CLAUDE_STDERR_TAIL_BYTES = 32 * 1024;
const ADDITIONAL_SENSITIVE_ENV_PATTERN = /(?:authorization|cookie|credential|database[_-]?url|private[_-]?key|netrc)/iu;
export function scrubClaudeSpawnEnv(env) {
    const safe = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined)
            continue;
        if (key.toUpperCase().startsWith(DSH_ENV_PREFIX))
            continue;
        if (SENSITIVE_ENV_PATTERN.test(key))
            continue;
        if (ADDITIONAL_SENSITIVE_ENV_PATTERN.test(key))
            continue;
        safe[key] = value;
    }
    return safe;
}
export class ManagedClaudeProcess extends EventEmitter {
    stdin;
    stdout;
    handle;
    #killed = false;
    #exitCode = null;
    #signalCode = null;
    constructor(handle) {
        super();
        if (handle.stdin === undefined || handle.stdout === undefined) {
            throw new Error('dsh-claude-code: managed Claude process requires piped stdin/stdout');
        }
        this.handle = handle;
        this.stdin = handle.stdin;
        this.stdout = handle.stdout;
        void handle.done.then(outcome => {
            this.#exitCode = outcome.exitCode;
            this.#signalCode = outcome.signal;
            this.emit('exit', outcome.exitCode, outcome.signal);
        }, error => {
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    }
    get killed() {
        return this.#killed;
    }
    get exitCode() {
        return this.#exitCode;
    }
    get signalCode() {
        return this.#signalCode;
    }
    kill(signal) {
        if (this.#exitCode !== null || this.#signalCode !== null)
            return false;
        this.#killed = true;
        this.handle.terminate();
        return true;
    }
    stderrTail() {
        return this.handle.collected.stderr?.readFrom(0).text ?? '';
    }
}
export function createManagedClaudeSpawner(runtime, executablePath, observe) {
    return options => {
        if (options.command !== executablePath) {
            throw new Error(`dsh-claude-code: SDK requested unexpected executable ${JSON.stringify(options.command)}`);
        }
        const handle = runtime.spawn({
            argv: [executablePath, ...options.args],
            cwd: options.cwd ?? process.cwd(),
            stdio: {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: { maxBytes: CLAUDE_STDERR_TAIL_BYTES },
            },
            graceMs: CLAUDE_PROCESS_GRACE_MS,
            signal: options.signal,
            env: scrubClaudeSpawnEnv(options.env),
        });
        const managed = new ManagedClaudeProcess(handle);
        observe?.(managed, options);
        return managed;
    };
}
//# sourceMappingURL=spawn.js.map