// Record the /model lineup one Claude Code release reports, as a drift fixture.
//   node --experimental-strip-types scripts/capture-model-lineup.mts [path/to/claude]
// Writes test/fixtures/claude-lineups/<version>.json; test/model-lineup-drift
// then fails if any id an earlier release advertised stops resolving.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { probeClaudeModels } from '../src/model-catalog.ts'

const executable = process.argv[2] ?? 'claude'
const version = /\d+\.\d+\.\d+/u.exec(execFileSync(executable, ['--version'], { encoding: 'utf8' }))?.[0]
if (version === undefined) throw new Error(`could not read the version of ${executable}`)
const models = await probeClaudeModels(executable)
const path = new URL(`../test/fixtures/claude-lineups/${version}.json`, import.meta.url)
writeFileSync(path, `${JSON.stringify(models.map(({ value, resolvedModel, displayName, description }) => ({ value, resolvedModel, displayName, description })), null, 2)}\n`)
console.log(`${version}: ${models.length} models -> ${path.pathname}`)
process.exit(0)
