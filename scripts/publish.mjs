#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')
const allowedArguments = new Set(['--dry-run'])
const unknownArguments = process.argv.slice(2).filter(argument => !allowedArguments.has(argument))
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments.join(', ')}`)
}

function run(command, args, options = {}) {
  const display = [command, ...args].join(' ')
  console.log(`> ${display}`)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (options.allowFailure === true) return result
  if (result.status !== 0) throw new Error(`${display} failed with exit code ${result.status ?? 'unknown'}`)
  return result
}

function capture(command, args) {
  return run(command, args, { capture: true }).stdout.trim()
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageName = packageJson.name
const version = packageJson.version
if (typeof packageName !== 'string' || typeof version !== 'string') {
  throw new Error('package.json must contain string name and version fields')
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Unsupported release version: ${version}`)
}

const tag = `v${version}`
const head = capture('git', ['rev-parse', 'HEAD'])
const branch = capture('git', ['branch', '--show-current'])
if (branch.length === 0) throw new Error('Releases require a checked-out branch')
if (capture('git', ['status', '--porcelain']).length > 0) {
  throw new Error('Working tree must be clean before publishing')
}

run('git', ['fetch', 'origin', branch])
const remoteHead = capture('git', ['rev-parse', `origin/${branch}`])
if (remoteHead !== head) {
  throw new Error(`HEAD ${head} must match origin/${branch} ${remoteHead} before publishing`)
}

run('npm', ['whoami'])
run('gh', ['auth', 'status'])
run('pnpm', ['check'])
run('npm', ['pack', '--dry-run'])

const published = run('npm', ['view', `${packageName}@${version}`, 'gitHead', '--json'], {
  capture: true,
  allowFailure: true,
})
let alreadyPublished = false
if (published.status === 0) {
  const publishedHead = JSON.parse(published.stdout.trim())
  if (publishedHead !== head) {
    throw new Error(`${packageName}@${version} is already published from ${publishedHead ?? 'an unknown commit'}, not ${head}`)
  }
  alreadyPublished = true
  console.log(`${packageName}@${version} is already published from HEAD; npm publish will be skipped.`)
} else if (!`${published.stderr}\n${published.stdout}`.includes('E404')) {
  process.stderr.write(published.stderr)
  throw new Error(`Unable to query ${packageName}@${version} from npm`)
}

const release = run('gh', ['release', 'view', tag, '--json', 'url'], {
  capture: true,
  allowFailure: true,
})
const releaseExists = release.status === 0
if (releaseExists) {
  const remoteTag = capture('git', ['ls-remote', 'origin', `refs/tags/${tag}`]).split(/\s+/)[0]
  if (remoteTag !== head) {
    throw new Error(`${tag} already exists at ${remoteTag || 'an unknown commit'}, not ${head}`)
  }
  console.log(`GitHub Release ${tag} already exists; release creation will be skipped.`)
}

if (dryRun) {
  console.log(`Release check passed for ${packageName}@${version} (${tag}).`)
  process.exit(0)
}

if (!alreadyPublished) {
  run('npm', ['publish', '--access', 'public'])
  const publishedHead = JSON.parse(capture('npm', ['view', `${packageName}@${version}`, 'gitHead', '--json']))
  if (publishedHead !== head) throw new Error(`npm published gitHead ${publishedHead} does not match ${head}`)
}

if (!releaseExists) {
  run('gh', [
    'release', 'create', tag,
    '--target', head,
    '--title', tag,
    '--generate-notes',
  ])
}

console.log(`Released ${packageName}@${version} and ${tag}.`)
