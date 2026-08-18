import { CLAUDE_CODE_PROVIDER } from "./constants.js";
export const name = 'claude-code-preset-route';
export function apply(ctx, config = {}) {
    ctx.on('agent/request', async (_payload, next) => {
        const upstream = await next();
        return {
            ...upstream,
            provider: CLAUDE_CODE_PROVIDER,
            model: config.model ?? upstream.model ?? 'default',
        };
    });
}
//# sourceMappingURL=preset-route.js.map