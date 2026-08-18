import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { claudeActivityDefinition, type ClaudeTurnData } from './conversation.ts'
import { ClaudeActivity, type ClaudeActivityInjected } from './ClaudeActivity.tsx'
import { ClaudeCodeSettings, type ClaudeCodeSettingsInjected } from './ClaudeCodeSettings.tsx'
import { en, zh, type ClaudeCodeSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.claude-code': ClaudeCodeSettingsKey
  }
}

export const name = 'dsh-claude-code-client'
export const inject = ['slots', 'locale', 'conversationEvents']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.claude-code'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-claude-code: client copy')
  const t = ctx.locale.bind(namespace) as ClaudeCodeSettingsInjected['t']
  ctx.effect(() => ctx.conversationEvents.register(claudeActivityDefinition), 'dsh-claude-code: activity projection')
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: 20,
    select: owner => owner.turn.data.get('claudeCode') ?? null,
    inject: (): ClaudeActivityInjected => ({ t }),
  }, ClaudeActivity as (props: { matched: ClaudeTurnData } & ClaudeActivityInjected) => React.ReactNode))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'claude-code',
    order: 16,
    label: () => t('nav'),
    inject: (): ClaudeCodeSettingsInjected => ({ t }),
  }, ClaudeCodeSettings))
}
