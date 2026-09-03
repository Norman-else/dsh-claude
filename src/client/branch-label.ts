import type { RepositoryStatus } from '../repository-status.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

/** `Detached HEAD` names a git implementation detail, not the user's checkout:
 *  a stopped rebase still knows which branch it parked, and that name is what
 *  every panel should show. Only a genuinely nameless HEAD falls back. */
export function branchLabel(
  repository: Pick<RepositoryStatus, 'branch' | 'detached'>,
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string,
): string {
  if (repository.branch !== undefined) return repository.branch
  return repository.detached === true ? t('repositoryDetached') : t('repositoryUnknownBranch')
}
