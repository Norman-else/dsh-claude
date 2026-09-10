import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

export interface ElectronNodeRunnerOptions {
  platform?: NodeJS.Platform
  /** Whether this process is an Electron binary; `process.execPath` is then
   *  the app, not Node. */
  electron?: boolean
}

/**
 * Make the Host's Windows Job runner start as Node when the Host itself is an
 * Electron utility process.
 *
 * Since DSH Desktop 2.0.7 the Host runs in `utilityProcess.fork` and, on
 * Windows, `subprocess-local` launches every ordinary target through a helper
 * it spawns as `[process.execPath, runner.js]`. Inside Electron that path is
 * `DSH Desktop.exe`, and the fork carries no `ELECTRON_RUN_AS_NODE`, so the
 * helper starts as a second GUI instance, yields to the running one, and exits
 * 0 without ever reporting -- the Host then fails the spawn with "Windows Job
 * runner exited with exit code 0 before proving its managed range empty".
 *
 * The runner's environment is read from `process.env` synchronously inside
 * `spawn()`, so the flag is set for exactly that call and removed after. The
 * target's own environment is built the same way, so the spec tells the Host
 * to drop the flag there: a target must not inherit a variable that turns any
 * Electron app it launches into a bare Node process.
 */
export function withElectronNodeRunner(
  runtime: SubprocessRuntime,
  options: ElectronNodeRunnerOptions = {},
): SubprocessRuntime {
  const platform = options.platform ?? process.platform
  const electron = options.electron ?? process.versions.electron !== undefined
  if (platform !== 'win32' || !electron) return runtime
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== 'spawn') {
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      }
      return (spec: SubprocessSpawnSpec) => {
        const withoutFlag: SubprocessSpawnSpec = { ...spec, env: { ...spec.env, [RUN_AS_NODE]: undefined } }
        if (process.env[RUN_AS_NODE] !== undefined) return target.spawn(withoutFlag)
        process.env[RUN_AS_NODE] = '1'
        try {
          return target.spawn(withoutFlag)
        } finally {
          delete process.env[RUN_AS_NODE]
        }
      }
    },
  })
}
