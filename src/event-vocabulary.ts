import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  CLAUDE_ACTIVITY_EVENT,
  CLAUDE_SESSION_BOUND_EVENT,
} from './constants.ts'

interface SessionVocabularyModule {
  KNOWN_SESSION_EVENT_TYPES?: unknown
}

export type SessionModuleResolver = (specifier: string, parent: string | URL) => string

export function resolveHostSessionModulePath(
  hostEntrypoint = process.argv[1],
  resolveModule: SessionModuleResolver = (specifier, parent) => createRequire(parent).resolve(specifier),
): string {
  const parent = hostEntrypoint === undefined
    ? import.meta.url
    : pathToFileURL(hostEntrypoint)
  return resolveModule('@deepseek-ai/dsh-session', parent)
}

export function registerClaudeEventVocabulary(module: SessionVocabularyModule): void {
  const vocabulary = module.KNOWN_SESSION_EVENT_TYPES
  if (!(vocabulary instanceof Set)) {
    throw new Error('dsh-claude-code: this Harness build does not expose an extensible session event vocabulary')
  }
  vocabulary.add(CLAUDE_SESSION_BOUND_EVENT)
  vocabulary.add(CLAUDE_ACTIVITY_EVENT)
}

export async function installClaudeEventVocabulary(hostEntrypoint = process.argv[1]): Promise<void> {
  const modulePath = resolveHostSessionModulePath(hostEntrypoint)
  const hostSession = await import(pathToFileURL(modulePath).href) as SessionVocabularyModule
  registerClaudeEventVocabulary(hostSession)
}
