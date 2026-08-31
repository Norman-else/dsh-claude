#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parseReleaseArguments, planRelease, writeVersion } from './release-version.mjs'

const { dryRun, requested } = parseReleaseArguments(process.argv.slice(2))

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

/** npm's `latest`, or undefined when the package has never been published. */
function latestPublishedVersion(name) {
  const result = run('npm', ['view', name, 'version'], { capture: true, allowFailure: true })
  // An existing package with nothing on `latest` answers with silence, which
  // is the same answer as a package that does not exist yet.
  if (result.status === 0) return result.stdout.trim().length === 0 ? undefined : result.stdout.trim()
  if (`${result.stderr}${result.stdout}`.includes('E404')) return undefined
  process.stderr.write(result.stderr)
  throw new Error(`Unable to query the published versions of ${name} from npm`)
}

const packageUrl = new URL('../package.json', import.meta.url)
const packageJson = JSON.parse(readFileSync(packageUrl, 'utf8'))
const packageName = packageJson.name
const manifestVersion = packageJson.version
if (typeof packageName !== 'string' || typeof manifestVersion !== 'string') {
  throw new Error('package.json must contain string name and version fields')
}

let head = capture('git', ['rev-parse', 'HEAD'])
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

/** The commit npm recorded for a version, or undefined when it has no such
 *  version. Null is a published version whose metadata carries no gitHead. */
function publishedGitHead(specifier) {
  const result = run('npm', ['view', specifier, 'gitHead', '--json'], { capture: true, allowFailure: true })
  if (result.status === 0) {
    const answer = result.stdout.trim()
    // npm answers a known package with an unknown version by saying nothing.
    return answer.length === 0 ? undefined : JSON.parse(answer) ?? null
  }
  if (`${result.stderr}${result.stdout}`.includes('E404')) return undefined
  process.stderr.write(result.stderr)
  throw new Error(`Unable to query ${specifier} from npm`)
}

// Three states, told apart rather than collapsed into one bump: npm already
// has this commit (finish the release), npm never saw the manifest version
// (finish the release that version was written for), or the manifest records
// something already shipped (start the next one).
const latest = latestPublishedVersion(packageName)
const manifestGitHead = publishedGitHead(`${packageName}@${manifestVersion}`)
const { version, action } = planRelease({
  current: manifestVersion,
  latest,
  manifestGitHead,
  head,
  requested,
})
const tag = `v${version}`
if (action === 'resume') {
  console.log(`${packageName}@${version} is already published from HEAD; finishing that release.`)
} else if (action === 'pending') {
  console.log(`package.json already carries ${version} and npm never took it; finishing that release rather than bumping past it.`)
} else if (latest === undefined) {
  console.log(`npm has no published version of ${packageName}; starting the sequence at ${version}.`)
} else {
  console.log(`Releasing ${packageName}@${version} (npm latest ${latest}, package.json ${manifestVersion}).`)
}

run('pnpm', ['check'])
run('npm', ['pack', '--dry-run'])

const alreadyPublished = action === 'resume'
if (!alreadyPublished) {
  const targetHead = version === manifestVersion ? manifestGitHead : publishedGitHead(`${packageName}@${version}`)
  if (targetHead !== undefined) {
    throw new Error(`${packageName}@${version} is already published from ${targetHead ?? 'an unknown commit'}, not ${head}`)
  }
}

// The manifest is written only when the version actually changes, so a run
// that resumes or finishes a pending release adds no second commit for the
// same version.
if (version !== manifestVersion) {
  if (dryRun) {
    console.log(`Dry run: package.json would move ${manifestVersion} -> ${version} and be committed to ${branch}.`)
  } else {
    writeVersion(packageUrl, manifestVersion, version)
    run('git', ['add', '--', 'package.json'])
    run('git', ['commit', '-m', `Bump version to ${version}`])
    run('git', ['push', 'origin', `HEAD:${branch}`])
    head = capture('git', ['rev-parse', 'HEAD'])
  }
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
