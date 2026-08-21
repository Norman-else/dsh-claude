import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandDescriptor } from '@deepseek-ai/dsh-commands'
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
  register(definition: CommandDefinition): () => void
  forward(agent: Agent, line: string): void
}

/**
 * Agent-scope command service contract. The commands service is unreachable
 * from the host plugin's view of `agent.ctx` ("without inject"), but the
 * preset route plugin runs INSIDE the agent's preset composition with
 * `commands` injected. Registrations made through the provided service land
 * in the agent's scope layer, which the command registry inherits into
 * `list(agent)` for exactly that agent — invisible to every other session.
 */
export interface ClaudeAgentCommandService {
  list(agent: unknown): readonly Pick<CommandDescriptor, 'name'>[]
  register(definition: CommandDefinition): () => void
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
  prefixed: boolean
}

interface DesiredCommand extends ClaudeCommandView {
  signature: string
  definition: CommandDefinition
}

interface LiveCommand {
  signature: string
  dispose: () => void
}

function bounded(value: string, maxChars: number): string {
  return redactText(value, maxChars)
}

function desiredCommands(
  catalog: readonly SlashCommand[],
  reservedNames: ReadonlySet<string>,
  forward: (agent: Agent, line: string) => void,
): Map<string, DesiredCommand> {
  const desired = new Map<string, DesiredCommand>()
  const assigned = new Set<string>()
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
      const signature = JSON.stringify({ publicName, claudeName, description, hint })
      desired.set(publicName, {
        publicName,
        claudeName,
        prefixed,
        signature,
        definition: {
          name: publicName,
          description,
          ...(hint.length === 0 ? {} : { input: { hint } }),
          recordInput: false,
          handler: ({ agent, rawInput }) => {
            // The invocation owns the exact session that received the command.
            // Never route through an agent captured during catalog refresh.
            forward(agent, `/${claudeName}${rawInput}`)
            return { kind: 'success' }
          },
        },
      })
      assigned.add(publicName)
    }
  }
  return desired
}

export class ClaudeCommandBridge {
  readonly #target: ClaudeCommandTarget
  readonly #live = new Map<string, LiveCommand>()

  constructor(target: ClaudeCommandTarget) {
    this.#target = target
  }

  refresh(catalog: readonly SlashCommand[]): readonly ClaudeCommandView[] {
    const owned = new Set(this.#live.keys())
    const reserved = new Set(
      this.#target.list()
        .map(command => command.name)
        .filter(name => !owned.has(name)),
    )
    // Client-side commandUi contributions (e.g. /model from
    // dsh-client-ui-model-selection) are invisible to the host registry, but
    // the web palette throws away its ENTIRE command group when a host
    // command collides with a contribution. Reserve those names so Claude's
    // same-named commands take the claude- prefix instead.
    for (const name of CLIENT_CONTRIBUTION_NAMES) reserved.add(name)
    const desired = desiredCommands(catalog, reserved, (agent, line) => this.#target.forward(agent, line))

    for (const [name, live] of [...this.#live]) {
      const next = desired.get(name)
      if (next?.signature === live.signature) continue
      live.dispose()
      this.#live.delete(name)
    }
    for (const [name, next] of desired) {
      if (this.#live.has(name)) continue
      this.#live.set(name, {
        signature: next.signature,
        dispose: this.#target.register(next.definition),
      })
    }
    return [...desired.values()].map(({ publicName, claudeName, prefixed }) => ({
      publicName,
      claudeName,
      prefixed,
    }))
  }

  dispose(): void {
    for (const command of this.#live.values()) command.dispose()
    this.#live.clear()
  }
}
