import { readFileSync, writeFileSync } from 'node:fs'

/** Version arithmetic for `pnpm release`, kept apart from the publish steps so
 *  it can be exercised without touching npm, git, or the working tree. */

/** Where a package nobody has published yet starts. */
export const FIRST_VERSION = '0.1.0'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u
const BUMP_LEVELS = new Set(['major', 'minor', 'patch'])

function parts(version) {
  const match = VERSION_PATTERN.exec(version)
  if (match === null) throw new Error(`Unsupported release version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

/** @returns negative when `left` precedes `right`, 0 when they are the same. */
export function compareVersions(left, right) {
  const a = parts(left)
  const b = parts(right)
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // Same numbers: a prerelease leads to the release, so it precedes it. Two
  // prereleases of the same version are not ordered against each other here --
  // this repository does not ship them, and guessing would be worse than
  // treating them as equal.
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return 0
}

/** Advance one component, zeroing everything below it. A prerelease resolves
 *  into the version it was leading to rather than being carried forward. */
export function bumpVersion(version, level = 'patch') {
  const { major, minor, patch, prerelease } = parts(version)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  if (level !== 'patch') throw new Error(`Unknown bump level: ${level}`)
  return prerelease === undefined ? `${major}.${minor}.${patch + 1}` : `${major}.${minor}.${patch}`
}

/** Read `pnpm release [version|major|minor|patch] [--dry-run] [--yes]`. */
export function parseReleaseArguments(argv) {
  let dryRun = false
  let requested
  for (const argument of argv) {
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument === '--yes') continue
    const candidate = argument.startsWith('v') ? argument.slice(1) : argument
    const next = BUMP_LEVELS.has(argument)
      ? { kind: 'bump', level: argument }
      : VERSION_PATTERN.test(candidate) ? { kind: 'exact', version: candidate } : undefined
    if (next === undefined) throw new Error(`Unknown argument: ${argument}`)
    if (requested !== undefined) throw new Error('Release takes one version or bump level, not several')
    requested = next
  }
  return { dryRun, requested }
}

/**
 * The version this release should carry.
 *
 * @param current - the version in package.json.
 * @param latest - npm's latest published version, or undefined when the
 *   package has never been published.
 * @param requested - an explicit version or bump level from the command line.
 */
export function nextReleaseVersion({ current, latest, requested }) {
  if (requested?.kind === 'exact') {
    // An unpublished package has no floor to clear: whatever the manifest
    // says, nothing has shipped, so any first version is a legal first version.
    const floor = latest === undefined ? undefined : highest(current, latest)
    if (floor !== undefined && compareVersions(requested.version, floor) <= 0) {
      throw new Error(`${requested.version} does not move past ${floor}`)
    }
    return requested.version
  }
  // Nothing published: this is release one, whatever the manifest happens to
  // say. A manifest ahead of an empty registry records no release at all.
  if (latest === undefined) return FIRST_VERSION
  // Whichever side is ahead is the truth about where the package has reached:
  // npm knows what shipped, the manifest may carry a bump that has not.
  return bumpVersion(highest(current, latest), requested?.level ?? 'patch')
}

function highest(left, right) {
  return compareVersions(left, right) >= 0 ? left : right
}

/** Rewrite only the version field of a package manifest, leaving the rest of
 *  the file byte for byte as it was: package.json is hand-maintained, and a
 *  parse-and-reserialize would bury the one line that actually changed under a
 *  reformat of everything around it. */
export function writeVersion(url, from, to) {
  const text = readFileSync(url, 'utf8')
  const field = `"version": "${from}"`
  const at = text.indexOf(field)
  if (at === -1) throw new Error(`Could not find ${field} in package.json`)
  if (text.indexOf(field, at + 1) !== -1) throw new Error(`${field} appears more than once in package.json`)
  writeFileSync(url, `${text.slice(0, at)}"version": "${to}"${text.slice(at + field.length)}`)
}
