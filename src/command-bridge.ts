import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { redactText } from './events.ts'

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
const MAX_DESCRIPTION_CHARS = 300
const MAX_HINT_CHARS = 120

/** DSH registry names reject `:`, but plugin-qualified Claude skills carry it
 *  (e.g. `awesome-skills:ci-deploy`). Derive a registry-safe public name while
 *  forwarding keeps the exact Claude-side name. */
function registryName(claudeName: string): string | undefined {
  if (COMMAND_NAME.test(claudeName)) return claudeName
  const short = claudeName.includes(':') ? claudeName.slice(claudeName.lastIndexOf(':') + 1) : undefined
  if (short !== undefined && COMMAND_NAME.test(short)) return short
  const sanitized = claudeName.replaceAll(':', '-').toLowerCase()
  return COMMAND_NAME.test(sanitized) ? sanitized : undefined
}

/**
 * Names registered as CLIENT-side commandUi contributions (not host
 * commands). The DSH web command palette fails its whole command group when
 * a host command name equals a contribution name
 * ("contribution /model collides with a host command"), so these can never
 * be registered by this bridge. Keep in sync with the client bundles:
 * dsh-client-ui-model-selection registers "model".
 */
const CLIENT_CONTRIBUTION_NAMES: ReadonlySet<string> = new Set(['model'])

export interface ClaudeCommandTarget {
  list(): readonly Pick<CommandDescriptor, 'name'>[]
}

/**
 * Agent-scope command-directory contract. The commands service is unreachable
 * from the host plugin's view of `agent.ctx` ("without inject"), but the
 * preset route plugin runs inside the agent's preset composition with
 * `commands` injected. The Host reads only the exact agent's effective names
 * for collision checks; Claude catalog entries are never registered there.
 */
export interface ClaudeAgentCommandService {
  list(agent: unknown): readonly Pick<CommandDescriptor, 'name'>[]
}

/**
 * Cordis service name the preset route provides (behind an entry-local
 * isolate realm, so each session gets its own instance) and the host reads
 * back with dsh-agent-presets' official `serviceForAgent(ctx, agent, name)`
 * — the supported cross-scope read for callers that already hold the agent.
 */
export const CLAUDE_COMMANDS_SERVICE = 'claudeCommands'

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCommands?: ClaudeAgentCommandService
  }
}

export interface ClaudeCommandView {
  publicName: string
  claudeName: string
  description: string
  hint?: string
  prefixed: boolean
}

function bounded(value: string, maxChars: number): string {
  return redactText(value, maxChars)
}

export function projectClaudeCommands(
  catalog: readonly SlashCommand[],
  target: ClaudeCommandTarget,
): readonly ClaudeCommandView[] {
  const reservedNames = new Set(target.list().map(command => command.name))
  // Client contributions are absent from the Host directory but share the
  // same slash menu, so reserve their public names explicitly.
  for (const name of CLIENT_CONTRIBUTION_NAMES) reservedNames.add(name)
  const assigned = new Set<string>()
  const views: ClaudeCommandView[] = []
  for (const command of catalog) {
    const names = [command.name, ...(command.aliases ?? [])]
    for (const claudeName of names) {
      const base = registryName(claudeName)
      if (base === undefined) continue
      let publicName = base
      let prefixed = false
      if (reservedNames.has(publicName) || assigned.has(publicName)) {
        publicName = `claude-${base}`
        prefixed = true
      }
      if (!COMMAND_NAME.test(publicName) || reservedNames.has(publicName) || assigned.has(publicName)) continue
      const description = bounded(command.description || `Claude Code /${command.name}`, MAX_DESCRIPTION_CHARS)
      const hint = bounded(command.argumentHint ?? '', MAX_HINT_CHARS)
      views.push({
        publicName,
        claudeName,
        description,
        ...(hint.length === 0 ? {} : { hint }),
        prefixed,
      })
      assigned.add(publicName)
    }
  }
  return views
}
