export declare const MANAGED_PRESET_FILES: readonly ["agent.cordis.yml", "preset.yml"];
export declare class ManagedPresetConflictError extends Error {
    readonly path: string;
    constructor(path: string);
}
export interface ManagedPresetPaths {
    sourceDir: string;
    targetDir: string;
}
export declare function defaultManagedPresetPaths(dshHome?: string): ManagedPresetPaths;
export declare function ensureManagedPreset(paths?: ManagedPresetPaths): Promise<'installed' | 'unchanged'>;
export declare function removeManagedPreset(paths?: ManagedPresetPaths): Promise<'removed' | 'absent'>;
//# sourceMappingURL=preset-installer.d.ts.map