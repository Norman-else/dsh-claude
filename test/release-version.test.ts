import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FIRST_VERSION,
  bumpVersion,
  compareVersions,
  nextReleaseVersion,
  parseReleaseArguments,
  writeVersion,
} from '../scripts/release-version.mjs'

describe('parseReleaseArguments', () => {
  it('reads the flags the release script already had', () => {
    expect(parseReleaseArguments(['--dry-run'])).toEqual({ dryRun: true, requested: undefined })
    expect(parseReleaseArguments(['--yes'])).toEqual({ dryRun: false, requested: undefined })
  })

  it('takes an explicit version to release', () => {
    expect(parseReleaseArguments(['0.2.0'])).toEqual({ dryRun: false, requested: { kind: 'exact', version: '0.2.0' } })
    expect(parseReleaseArguments(['v0.2.0'])).toEqual({ dryRun: false, requested: { kind: 'exact', version: '0.2.0' } })
  })

  it('takes a bump level instead of a version', () => {
    expect(parseReleaseArguments(['minor'])).toEqual({ dryRun: false, requested: { kind: 'bump', level: 'minor' } })
  })

  it('refuses what it cannot interpret rather than releasing something unintended', () => {
    expect(() => parseReleaseArguments(['--force'])).toThrow(/Unknown argument/u)
    expect(() => parseReleaseArguments(['0.2'])).toThrow(/Unknown argument/u)
    expect(() => parseReleaseArguments(['0.2.0', '0.3.0'])).toThrow(/one version/u)
  })
})

describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    // A prerelease precedes the release it leads to.
    expect(compareVersions('0.1.1-rc.1', '0.1.1')).toBeLessThan(0)
  })
})

describe('bumpVersion', () => {
  it('advances one component and zeroes the ones below it', () => {
    expect(bumpVersion('0.1.34', 'patch')).toBe('0.1.35')
    expect(bumpVersion('0.1.34', 'minor')).toBe('0.2.0')
    expect(bumpVersion('0.1.34', 'major')).toBe('1.0.0')
    // A prerelease resolves into the release it was leading to.
    expect(bumpVersion('0.2.0-rc.1', 'patch')).toBe('0.2.0')
  })
})

describe('nextReleaseVersion', () => {
  it('starts a package nobody has published yet at the first version', () => {
    expect(nextReleaseVersion({ current: '0.0.0', latest: undefined })).toBe(FIRST_VERSION)
    expect(FIRST_VERSION).toBe('0.1.0')
  })

  it('bumps the patch of whatever is already out there', () => {
    expect(nextReleaseVersion({ current: '0.1.34', latest: '0.1.34' })).toBe('0.1.35')
  })

  it('never proposes a version behind the manifest, whichever side is ahead', () => {
    // A manifest bumped by hand and never published still wins the comparison,
    // so the next release cannot silently reuse a number already in the tree.
    expect(nextReleaseVersion({ current: '0.2.0', latest: '0.1.34' })).toBe('0.2.1')
    expect(nextReleaseVersion({ current: '0.1.0', latest: '0.1.34' })).toBe('0.1.35')
  })

  it('applies a requested bump level to the same base', () => {
    expect(nextReleaseVersion({ current: '0.1.34', latest: '0.1.34', requested: { kind: 'bump', level: 'minor' } }))
      .toBe('0.2.0')
  })

  it('takes an explicit version only when it moves the package forward', () => {
    expect(nextReleaseVersion({ current: '0.1.34', latest: '0.1.34', requested: { kind: 'exact', version: '1.0.0' } }))
      .toBe('1.0.0')
    expect(() => nextReleaseVersion({ current: '0.1.34', latest: '0.1.34', requested: { kind: 'exact', version: '0.1.30' } }))
      .toThrow(/0\.1\.34/u)
    expect(() => nextReleaseVersion({ current: '0.1.34', latest: '0.1.34', requested: { kind: 'exact', version: '0.1.34' } }))
      .toThrow(/0\.1\.34/u)
  })

  it('honours an explicit first version for an unpublished package', () => {
    expect(nextReleaseVersion({ current: '0.0.0', latest: undefined, requested: { kind: 'exact', version: '1.0.0' } }))
      .toBe('1.0.0')
  })
})
describe('writeVersion', () => {
  function manifest(body: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-claude-release-')), 'package.json')
    writeFileSync(path, body)
    return path
  }

  it('touches the version line and nothing else', () => {
    const body = '{\n  \"name\": \"@scope/pkg\",\n  \"version\": \"0.1.34\",\n  \"scripts\": {}\n}\n'
    const path = manifest(body)
    writeVersion(path, '0.1.34', '0.1.35')
    expect(readFileSync(path, 'utf8')).toBe(body.replace('0.1.34', '0.1.35'))
  })

  it('refuses to guess when the version it was told to replace is not there', () => {
    const path = manifest('{ \"version\": \"9.9.9\" }')
    expect(() => writeVersion(path, '0.1.34', '0.1.35')).toThrow(/Could not find/u)
  })

  it('refuses to guess when more than one field matches', () => {
    const path = manifest('{ \"version\": \"0.1.34\", \"peer\": { \"version\": \"0.1.34\" } }')
    expect(() => writeVersion(path, '0.1.34', '0.1.35')).toThrow(/more than once/u)
  })
})
