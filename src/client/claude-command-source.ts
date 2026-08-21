import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext,
  CommandClaim,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ClaudeCommandView } from '../command-bridge.ts'
import type { ClaudeProjectionStore } from './projection.ts'

const SOURCE_NAME = 'Claude Code'

function commandsFor(store: ClaudeProjectionStore, session: ClientSessionContext): readonly ClaudeCommandView[] {
  const projection = store.source(session.sessionId).getSnapshot()
  return projection.owned ? projection.commands : []
}

function findCommand(
  store: ClaudeProjectionStore,
  session: ClientSessionContext,
  publicName: string,
): ClaudeCommandView | undefined {
  return commandsFor(store, session).find(command => command.publicName === publicName)
}

function claimFor(ctx: ClientContext, session: ClientSessionContext, command: ClaudeCommandView): CommandClaim {
  return {
    token: `/${command.publicName} `,
    ...(command.hint === undefined ? {} : { hint: command.hint }),
    async submit(args) {
      return await submitClaudeCommand(ctx, session, command, args)
    },
  }
}

function pickCommand(ctx: ClientContext, store: ClaudeProjectionStore, pick: InputTriggerPick): PickOutcome {
  const command = findCommand(store, pick.session, pick.candidate.name)
  if (command === undefined) return undefined
  return { claim: claimFor(ctx, pick.session, command) }
}

/** Build a client-owned slash source. It never calls command.execute, so
 * Claude Skill submission creates only the ordinary user-message turn. */
export function createClaudeCommandSource(ctx: ClientContext, store: ClaudeProjectionStore): InputTriggerSource {
  return {
    trigger: '/',
    name: SOURCE_NAME,
    order: 10,
    async candidates(session, request): Promise<readonly InputTriggerCandidate[]> {
      if (request.position !== 'leading') return []
      const query = request.query.toLocaleLowerCase()
      return commandsFor(store, session)
        .filter(command => command.publicName.toLocaleLowerCase().includes(query))
        .map(command => ({
          name: command.publicName,
          description: command.description,
          ...(command.hint === undefined ? {} : { hint: command.hint }),
        }))
    },
    onPick(pick) {
      return pickCommand(ctx, store, pick)
    },
    matchSpace(session, token) {
      if (!token.startsWith('/')) return undefined
      const command = findCommand(store, session, token.slice(1))
      return command === undefined ? undefined : { claim: claimFor(ctx, session, command) }
    },
    async matchEnter(session, line) {
      if (!line.startsWith('/')) return undefined
      const separator = line.indexOf(' ')
      const publicName = line.slice(1, separator === -1 ? undefined : separator)
      const command = findCommand(store, session, publicName)
      return command === undefined ? undefined : { claim: claimFor(ctx, session, command) }
    },
    lexicon(session) {
      return commandsFor(store, session).map(command => command.publicName)
    },
    subscribeLexicon(session, listener) {
      return store.source(session.sessionId).subscribe(listener)
    },
  }
}

/** Execute through this plugin's injected services rebound to the target
 * session scope; the input-trigger action context does not inject them. */
export async function submitClaudeCommand(
  ctx: ClientContext,
  session: ClientSessionContext,
  command: ClaudeCommandView,
  args: string,
): Promise<{ kind: 'success' | 'error'; text?: string }> {
  const scoped = ctx.sessions.scope(session.sessionId)
  if (scoped === undefined) return { kind: 'error', text: 'Claude session is unavailable' }
  const line = `/${command.claudeName}${args.length === 0 ? '' : ` ${args}`}`
  try {
    await scoped.conversation.send(line)
    return { kind: 'success' }
  } catch (error) {
    return {
      kind: 'error',
      text: error instanceof Error ? error.message : String(error),
    }
  }
}
