import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Extensions mapped onto a funcname driver, so `@@` hunk headers name the
 *  method a change sits in. Without one git falls back to "the last line that
 *  starts in column 0", which in Java or Kotlin is always the class. */
export const DIFF_ATTRIBUTES = [
  '*.java diff=java',
  '*.kt diff=kotlin',
  '*.kts diff=kotlin',
  '*.py diff=python',
  '*.pyi diff=python',
  '*.js diff=dshweb',
  '*.jsx diff=dshweb',
  '*.mjs diff=dshweb',
  '*.cjs diff=dshweb',
  '*.ts diff=dshweb',
  '*.tsx diff=dshweb',
  '*.mts diff=dshweb',
  '*.cts diff=dshweb',
  '*.vue diff=dshweb',
  '*.svelte diff=dshweb',
  '*.css diff=css',
  '*.scss diff=css',
  '*.less diff=css',
  '',
].join('\n')

/** git ships no JavaScript driver, so this is the one pattern we write ourselves.
 *
 *  POSIX extended regexes, one per line, matched top-down: a leading `!` marks a
 *  line that can never be a header, and the reported text is capture group 1 --
 *  hence the outer parentheses around everything worth showing.
 *
 *  Line 2 keeps git's own fallback (anything unindented), because a driver
 *  replaces that fallback rather than extending it, and most of a frontend file's
 *  declarations already live in column 0. Lines 3 and 4 add what the fallback
 *  cannot see: nested declarations, and indented class or object methods.
 *
 *  ponytail: a method line must end in `{`. Allowing `)` too would pick up every
 *  bare `foo(bar)` statement, which reads as a header and hides the real one.
 */
export const DSHWEB_FUNCNAME = [
  '!^[ \t]*(if|else|for|while|do|switch|case|catch|try|finally|return|await|new|throw|typeof)[^A-Za-z0-9_$]',
  '^([A-Za-z_$].*)$',
  '^[ \t]*((export[ \t]+)?(default[ \t]+)?(declare[ \t]+)?(abstract[ \t]+)?(async[ \t]+)?(function|class|interface|enum|namespace|module)[ \t].*)$',
  '^[ \t]*(((public|private|protected|static|readonly|abstract|async|get|set)[ \t]+)*[A-Za-z_$#][A-Za-z0-9_$]*[ \t]*[:=]?[ \t]*(async[ \t]+)?[(<][^;]*\\{)[ \t]*$',
].join('\n')

let attributesFile: Promise<string | undefined> | undefined

async function writeAttributes(): Promise<string | undefined> {
  const path = dshHomePath('plugins', 'dsh-claude', 'diff-attributes')
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, DIFF_ATTRIBUTES, 'utf8')
    return path
  } catch {
    return undefined
  }
}

/** `-c` overrides to place in front of a `git diff`, teaching it which funcname
 *  driver each extension uses.
 *
 *  `core.attributesFile` is the lowest-precedence attribute source, so a
 *  repository that already declares its own `.gitattributes` still wins. Better
 *  hunk headers are cosmetic: a failed write drops the overrides and the diff
 *  runs exactly as before.
 */
export async function diffFuncnameArgs(): Promise<readonly string[]> {
  attributesFile ??= writeAttributes()
  const path = await attributesFile
  if (path === undefined) return []
  return ['-c', `core.attributesFile=${path}`, '-c', `diff.dshweb.xfuncname=${DSHWEB_FUNCNAME}`]
}
