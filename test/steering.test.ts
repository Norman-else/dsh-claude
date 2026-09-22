import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { mountClaudeSteering } from '../src/steering.ts'

type InboxListener = (payload: { agent: Agent; message: UserMessage }) => void

function userMessage(text: string, id = 'message-1'): UserMessage {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  } as unknown as UserMessage
}

/** An agent whose inbox behaves like the Host's: a message is pending until it
 *  is removed, and an appended one is pending again. */
function fakeAgent(pending: UserMessage[]) {
  const append = vi.fn((_target: string, message: UserMessage) => { pending.push(message) })
  const remove = vi.fn((messageId: string) => {
    const index = pending.findIndex(item => item.id === messageId)
    if (index === -1) return false
    pending.splice(index, 1)
    return true
  })
  const logged: unknown[] = []
  const sessionAppend = vi.fn((type: string, message: UserMessage) => { logged.push([type, message]) })
  return {
    id: 'dsh-session-1',
    inbox: { get nextStep() { return pending }, append, remove },
    session: { append: sessionAppend },
  } as unknown as Agent & {
    inbox: { append: typeof append; remove: typeof remove }
    session: { append: typeof sessionAppend }
  }
}

function mount(
  supervisor: { canSteer: () => boolean; deliverSteering: () => 'delivered' | 'unavailable' },
  native = false,
) {
  let listener: InboxListener | undefined
  const warnings: string[] = []
  const stop = vi.fn()
  const ctx = {
    on: (event: string, handler: InboxListener) => {
      expect(event).toBe('agent/inbox/inserted')
      listener = handler
      return stop
    },
  }
  const attachments = {
    imageLimits: { maxImagesPerMessage: 4, maxImageBytes: 1_000, maxTotalImageBytes: 4_000 },
    readImage: vi.fn(),
    fileHostPath: vi.fn(() => '/var/attachments/file'),
  }
  const dispose = mountClaudeSteering(
    ctx as never,
    supervisor as never,
    attachments as never,
    () => native,
    message => { warnings.push(message) },
  )
  return { insert: (payload: { agent: Agent; message: UserMessage }) => listener?.(payload), warnings, dispose, stop }
}

/** Let the bridge's own async delivery settle. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

describe('steering bridge', () => {
  it('takes a steered message out of the inbox and hands it to the running turn', async () => {
    // Nothing else would: one DSH step is one whole Claude turn, so a message
    // left in the inbox waits for the turn it was meant to change.
    const deliverSteering = vi.fn(() => 'delivered' as const)
    const pending = [userMessage('change of plan')]
    const agent = fakeAgent(pending)
    const { insert } = mount({ canSteer: () => true, deliverSteering })
    insert({ agent, message: pending[0]! })
    await settle()
    // Text-only resolves to a plain prompt string, exactly as an ordinary send does.
    expect(deliverSteering).toHaveBeenCalledWith('dsh-session-1', 'change of plan')
    expect(pending).toHaveLength(0)
    expect(agent.inbox.append).not.toHaveBeenCalled()
    // The plugin transcript draws its own row where the message arrived, so
    // nothing is put on DSH’s surface ahead of the turn's prose.
    expect(agent.session.append).not.toHaveBeenCalled()
  })

  it('records the message on DSH’s surface when DSH draws the session itself', async () => {
    // The native renderer has no plugin transcript to draw the row in.
    const pending = [userMessage('change of plan')]
    const agent = fakeAgent(pending)
    const { insert } = mount({ canSteer: () => true, deliverSteering: () => 'delivered' }, true)
    insert({ agent, message: pending[0]! })
    await settle()
    expect(agent.session.append).toHaveBeenCalledWith(
      'user/message',
      expect.objectContaining({ id: 'message-1' }),
      { surfaceOp: 'append' },
    )
  })

  it('does not record a message it could not deliver', async () => {
    const pending = [userMessage('too late')]
    const agent = fakeAgent(pending)
    const { insert } = mount({ canSteer: () => true, deliverSteering: () => 'unavailable' }, true)
    insert({ agent, message: pending[0]! })
    await settle()
    // The Host still owns it, and will log it when its own boundary claims it.
    expect(agent.session.append).not.toHaveBeenCalled()
  })

  it('leaves the message in the inbox when no turn can take it', async () => {
    // The Host's own boundary delivers it at the end of the turn, as before.
    const deliverSteering = vi.fn(() => 'unavailable' as const)
    const pending = [userMessage('wait for me')]
    const agent = fakeAgent(pending)
    const { insert } = mount({ canSteer: () => false, deliverSteering })
    insert({ agent, message: pending[0]! })
    await settle()
    expect(deliverSteering).not.toHaveBeenCalled()
    expect(agent.inbox.remove).not.toHaveBeenCalled()
    expect(pending).toHaveLength(1)
  })

  it('puts the message back when the turn stops being steerable mid-delivery', async () => {
    // canSteer answered yes, the turn ended before the push landed: the message
    // must still be pending, or the reader's words are gone.
    const deliverSteering = vi.fn(() => 'unavailable' as const)
    const pending = [userMessage('too late')]
    const agent = fakeAgent(pending)
    const { insert } = mount({ canSteer: () => true, deliverSteering })
    insert({ agent, message: pending[0]! })
    await settle()
    expect(deliverSteering).toHaveBeenCalled()
    expect(agent.inbox.append).toHaveBeenCalledWith('next-step', expect.objectContaining({ id: 'message-1' }))
    expect(pending.map(item => item.id)).toEqual(['message-1'])
  })

  it('ignores a message that is not the reader steering a turn', async () => {
    const deliverSteering = vi.fn(() => 'delivered' as const)
    const plugin = { ...userMessage('from a plugin'), source: { kind: 'plugin', plugin: 'other' } } as unknown as UserMessage
    const pending = [plugin]
    const agent = fakeAgent(pending)
    const { insert } = mount({ canSteer: () => true, deliverSteering })
    insert({ agent, message: plugin })
    // A next-turn message is not steering either: it is not in next-step.
    insert({ agent, message: userMessage('next turn', 'message-2') })
    await settle()
    expect(deliverSteering).not.toHaveBeenCalled()
    expect(pending).toHaveLength(1)
  })

  it('keeps the message and reports when its content cannot be resolved', async () => {
    const deliverSteering = vi.fn(() => 'delivered' as const)
    const empty = { ...userMessage(''), content: [] } as unknown as UserMessage
    const pending = [empty]
    const agent = fakeAgent(pending)
    const { insert, warnings } = mount({ canSteer: () => true, deliverSteering })
    insert({ agent, message: empty })
    await settle()
    expect(deliverSteering).not.toHaveBeenCalled()
    expect(pending.map(item => item.id)).toEqual(['message-1'])
    expect(warnings[0]).toContain('kept for the next turn')
  })

  it('stops listening when the plugin disposes it', () => {
    const { dispose, stop } = mount({ canSteer: () => true, deliverSteering: () => 'delivered' })
    dispose()
    expect(stop).toHaveBeenCalledOnce()
  })
})
