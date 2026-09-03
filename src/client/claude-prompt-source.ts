import type { InputTriggerCandidate, InputTriggerPick, InputTriggerSource, PickOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ClaudePromptView } from '../prompts.ts'
import { claudePrompts } from './prompt-api.ts'

/**
 * The user's own prompt snippets as a second `/` group.
 *
 * Unlike {@link createClaudeCommandSource}, a pick here settles as plain text:
 * the pipeline replaces the trigger token with the snippet body and leaves the
 * caret after it, so the draft stays editable and nothing is sent. A snippet is
 * a half-written message, not a command.
 */
export function createClaudePromptSource(
  groupName: string,
  load: () => Promise<readonly ClaudePromptView[]> = claudePrompts,
): InputTriggerSource {
  // onPick is synchronous, so the roll `candidates` just filtered is where the
  // body has to come from; the pipeline only ever picks a candidate that call
  // produced.
  let known: readonly ClaudePromptView[] = []
  return {
    trigger: '/',
    name: groupName,
    // The Claude Code command group registers at 10; snippets sit under it.
    order: 20,
    async candidates(_session, request): Promise<readonly InputTriggerCandidate[]> {
      if (request.position !== 'leading') return []
      known = await load()
      const query = request.query.toLocaleLowerCase()
      return known
        .filter(prompt => prompt.name.toLocaleLowerCase().includes(query))
        .map(prompt => ({ name: prompt.name, description: prompt.description }))
    },
    onPick(pick: InputTriggerPick): PickOutcome {
      const prompt = known.find(item => item.name === pick.candidate.name)
      return prompt === undefined ? undefined : { text: prompt.body }
    },
  }
}
