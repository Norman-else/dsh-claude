#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')
const allowedArguments = new Set(['--dry-run', '--yes'])
const unknownArguments = process.argv.slice(2).filter(argument => !allowedArguments.has(argument))
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments.join(', ')}`)
}

const WINDOWS_COMMAND_SHIMS = new Set(['npm', 'pnpm', 'npx'])

function windowsCommandLine(command, args) {
  for (const value of args) {
    if (/["%&|<>^!()\r\n]/u.test(value)) {
      throw new Error(`Unsafe Windows command argument: ${value}`)
    }
  }
  return [`${command}.cmd`, ...args.map(value => `"${value}"`)].join(' ')
}

function spawnCommand(command, args) {
  if (process.platform !== 'win32' || !WINDOWS_COMMAND_SHIMS.has(command)) {
    return { file: command, args }
  }
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', windowsCommandLine(command, args)],
  }
}

function run(command, args, options = {}) {
  const display = [command, ...args].join(' ')
  console.log(`> ${display}`)
  const invocation = spawnCommand(command, args)
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
    windowsVerbatimArguments: process.platform === 'win32' && WINDOWS_COMMAND_SHIMS.has(command),
  })
  if (result.error !== undefined) throw result.error
  if (options.allowFailure === true) return result
  if (result.status !== 0) throw new Error(`${display} failed with exit code ${result.status ?? 'unknown'}`)
  return result
}

function capture(command, args) {
  return run(command, args, { capture: true }).stdout.trim()
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitForPublishedGitHead(packageVersion, expectedHead) {
  const attempts = 12
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run('npm', ['view', packageVersion, 'gitHead', '--json'], {
      capture: true,
      allowFailure: true,
    })
    if (result.status === 0) {
      const publishedHead = JSON.parse(result.stdout.trim())
      if (publishedHead !== expectedHead) {
        throw new Error(`npm published gitHead ${publishedHead ?? 'unknown'} does not match ${expectedHead}`)
      }
      return
    }
    if (attempt === attempts) {
      process.stderr.write(result.stderr)
      throw new Error(`${packageVersion} was published but did not become readable from npm within 60 seconds`)
    }
    console.log(`npm metadata is not visible yet; retrying in 5 seconds (${attempt}/${attempts})...`)
    await sleep(5_000)
  }
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
  await waitForPublishedGitHead(`${packageName}@${version}`, head)
}

if (!releaseExists) {
  // GitHub's generated notes only enumerate merged pull requests, so direct
  // commits would otherwise leave the release body empty. Prepend the full
  // commit list; the generated PR list and compare link are appended after it.
  const previousTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], {
    capture: true,
    allowFailure: true,
  })
  const range = previousTag.status === 0 ? [`${previousTag.stdout.trim()}..HEAD`] : []
  const subjects = capture('git', ['log', '--format=- %s (%h)', ...range])
  run('gh', [
    'release', 'create', tag,
    '--target', head,
    '--title', tag,
    '--generate-notes',
    ...(subjects.length === 0 ? [] : ['--notes', `## Commits\n\n${subjects}\n`]),
  ])
}

console.log(`Released ${packageName}@${version} and ${tag}.`)
