import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "llm-claude-code-cli";
export declare const inject: string[];
export interface Config {
    executablePath?: string;
    model?: string;
    idleTimeoutMs?: number;
    maxProcesses?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map