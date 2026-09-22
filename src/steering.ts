import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveDirectUserPrompt } from './adapter.ts'
import type { ClaudeSupervisor } from './supervisor.ts'

/** What this bridge needs from the supervisor: the entry point that reaches the
 *  process running the turn. */
interface SteeringTarget {
  canSteer: ClaudeSupervisor['canSteer']
  deliverSteering: ClaudeSupervisor['deliverSteering']
}

type SteeringAttachments = Parameters<typeof resolveDirectUserPrompt>[1]

/** Carry a steered message into the Claude turn that is already running.
 *
 *  DSH steers by putting the message in the agent's next-step inbox, which its
 *  own driver claims at the next step boundary. This preset has no such
 *  boundary: one DSH step is one whole Claude Code turn, so an unclaimed
 *  steered message waits for the turn to end and arrives as an ordinary
 *  follow-up — the opposite of what the reader asked for by typing during the
 *  turn.
 *
 *  Claude Code's own steering is a message pushed into the CLI's input stream,
 *  which it reads at its next model step without restarting the turn. So the
 *  message is taken out of the inbox here and handed to the process that owns
 *  the running turn. Anything this bridge cannot deliver goes back where it
 *  came from, unchanged, and the turn boundary delivers it as before.
 */
export function mountClaudeSteering(
  ctx: Context,
  supervisor: SteeringTarget,
  attachments: AttachmentStore,
  /** Whether DSH draws this session itself; the plugin transcript is not drawn
   *  then, so the steered message needs a node on DSH’s own surface. */
  nativeRenderer: () => Promise<boolean> | boolean,
  onError: (message: string) => void,
): () => void {
  /** Put the steered message on DSH's own surface — for the renderer that has
   *  nowhere else to draw it.
   *
   *  The Host logs a message when its driver claims it out of the inbox, and
   *  this bridge claims it instead, so nothing else will. The plugin transcript
   *  draws its own row where the message arrived, which is where the reader
   *  typed it; DSH's surface can only take it as a node ahead of the turn's
   *  prose, which settles as one node at the end — so the whole answer would
   *  read as the reply to the steered message. That is still better than not
   *  showing it at all, so it is what the native renderer gets. */
  const record = async (agent: Agent, message: UserMessage): Promise<void> => {
    try {
      if (!await nativeRenderer()) return
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    } catch (error) {
      onError(`dsh-claude: steered message was delivered but not recorded for ${agent.id as string}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const deliver = async (agent: Agent, message: UserMessage): Promise<void> => {
    const sessionId = agent.id as string
    // Taken out first: a message that is still pending when the turn's next
    // step boundary arrives would be delivered twice, once by each path. The
    // inbox is restored below for every message this bridge does not deliver.
    if (!agent.inbox.remove(message.id)) return
    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      agent.inbox.append('next-step', message)
    }
    try {
      // The same builder an ordinary send uses, so image limits and the wording
      // a file arrives with cannot drift between a steered message and a turn.
      const prompt = await resolveDirectUserPrompt([message], attachments as SteeringAttachments)
      if (supervisor.deliverSteering(sessionId, prompt) === 'delivered') {
        await record(agent, message)
        return
      }
      restore()
    } catch (error) {
      restore()
      onError(`dsh-claude: steered message kept for the next turn for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const steerable = (agent: Agent, message: UserMessage): boolean =>
    message.role === 'user'
    && message.source.kind === 'user'
    && supervisor.canSteer(agent.id as string)
    && agent.inbox.nextStep.some(pending => pending.id === message.id)

  return ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // A session with no running Claude turn is left alone: `deliverSteering`
    // would refuse it anyway, and taking it out of the inbox would strand it.
    if (!steerable(agent, message)) return
    void deliver(agent, message)
  })
}
