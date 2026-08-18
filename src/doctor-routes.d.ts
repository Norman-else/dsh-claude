import type { Context } from '@deepseek-ai/cordis';
import { type ExecutableRuntime } from './executable.ts';
import type { ClaudeSupervisor, ClaudeSupervisorConfig } from './supervisor.ts';
export declare const CLAUDE_DOCTOR_PROBE_TIMEOUT_MS = 15000;
export declare function registerClaudeDoctorRoutes(ctx: Context, runtime: ExecutableRuntime, supervisor: ClaudeSupervisor, config: ClaudeSupervisorConfig, resolutionError?: unknown): void;
//# sourceMappingURL=doctor-routes.d.ts.map