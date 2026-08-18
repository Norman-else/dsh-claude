import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { CLAUDE_CODE_PRESET_ID } from "./constants.js";
export const MANAGED_PRESET_FILES = ['agent.cordis.yml', 'preset.yml'];
export class ManagedPresetConflictError extends Error {
    path;
    constructor(path) {
        super(`dsh-claude-code: refusing to overwrite user-modified preset file ${path}`);
        this.name = 'ManagedPresetConflictError';
        this.path = path;
    }
}
export function defaultManagedPresetPaths(dshHome) {
    const packageRoot = fileURLToPath(new URL('../', import.meta.url));
    return {
        sourceDir: join(packageRoot, 'preset'),
        targetDir: dshHome === undefined
            ? dshHomePath('.agent-presets', CLAUDE_CODE_PRESET_ID)
            : join(dshHome, '.agent-presets', CLAUDE_CODE_PRESET_ID),
    };
}
async function readIfPresent(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function atomicWrite(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try {
            await link(temporary, path);
            return true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            if (await readIfPresent(path) === content)
                return false;
            throw new ManagedPresetConflictError(path);
        }
    }
    finally {
        await rm(temporary, { force: true });
    }
}
export async function ensureManagedPreset(paths = defaultManagedPresetPaths()) {
    const expected = await Promise.all(MANAGED_PRESET_FILES.map(async (file) => ({
        file,
        content: await readFile(join(paths.sourceDir, file), 'utf8'),
    })));
    let changed = false;
    for (const { file, content } of expected) {
        const target = join(paths.targetDir, file);
        const current = await readIfPresent(target);
        if (current === content)
            continue;
        if (current !== undefined)
            throw new ManagedPresetConflictError(target);
        changed = await atomicWrite(target, content) || changed;
    }
    return changed ? 'installed' : 'unchanged';
}
export async function removeManagedPreset(paths = defaultManagedPresetPaths()) {
    let removed = false;
    for (const file of MANAGED_PRESET_FILES) {
        const source = await readFile(join(paths.sourceDir, file), 'utf8');
        const target = join(paths.targetDir, file);
        const current = await readIfPresent(target);
        if (current === undefined)
            continue;
        if (current !== source)
            throw new ManagedPresetConflictError(target);
        await rm(target);
        removed = true;
    }
    try {
        if ((await readdir(paths.targetDir)).length === 0)
            await rmdir(paths.targetDir);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    return removed ? 'removed' : 'absent';
}
//# sourceMappingURL=preset-installer.js.map