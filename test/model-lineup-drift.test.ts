import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { canonicalClaudeModelId, latestClaudeModels, recordClaudeModels, resetClaudeModels } from '../src/model-catalog.ts'

/** Real `/model` lineups, one per Claude Code release, recorded by
 *  scripts/capture-model-lineup.mts after each CLI upgrade. */
const DIRECTORY = new URL('./fixtures/claude-lineups/', import.meta.url)
const releases = readdirSync(DIRECTORY)
  .filter(name => name.endsWith('.json'))
  .map(name => ({
    version: name.slice(0, -'.json'.length),
    models: JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8')) as ModelInfo[],
  }))
  .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }))

function catalogOf(models: readonly ModelInfo[]): readonly string[] {
  resetClaudeModels()
  recordClaudeModels(models)
  return latestClaudeModels().map(row => row.id)
}

describe('Claude model lineup drift', () => {
  afterEach(() => { resetClaudeModels() })

  it('has recorded lineups to check', () => {
    expect(releases.length).toBeGreaterThanOrEqual(2)
  })

  // DSH persists a selection as the row id and prints `claude/<id>` for one no
  // row carries. Every id any earlier release advertised must therefore still
  // be a row after an upgrade, or be rewritten to one by the request hook.
  it.each(releases.slice(1).map((release, index) => [release.version, index + 1] as const))(
    'keeps every id an earlier release advertised resolvable on %s',
    (_version, index) => {
      const earlier = new Set(releases.slice(0, index).flatMap(release => catalogOf(release.models)))
      const current = new Set(catalogOf(releases[index]!.models))
      const stranded = [...earlier].filter(id => !current.has(id) && !current.has(canonicalClaudeModelId(id)))
      expect(stranded).toEqual([])
    },
  )
})
