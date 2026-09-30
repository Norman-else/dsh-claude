import { useEffect, useMemo, useState } from 'react'

/** Clickable inline-code file paths in Claude's prose.
 *
 *  The Host links an inline-code path only when a first-party DSH write tool
 *  or `present` produced it; Claude's Write, Edit, and Bash are neither, so a
 *  file Claude made shows as dead code. Here every path-shaped token is asked
 *  of the Host's `workspaceFiles.stat` instead, and a regular file that exists
 *  becomes the same mention button the Host draws — covering files a shell
 *  command wrote, which no tool-call record names. */

/** What a mention needs from the Host, scoped to one Session. */
export interface FileMentionSource {
  /** Resolves true when the path is a readable regular file; never rejects. */
  exists(path: string): Promise<boolean>
  open(path: string, line?: number): void
}

/** `MarkdownText`'s `fileMentions` vocabulary. */
export interface FileMentions {
  resolve(value: string): { open(): void; label: string; title: string } | undefined
}

export interface FileToken {
  path: string
  line?: number
}

const MAX_TOKEN_CHARS = 512
const LINE_SUFFIX = /:(\d+)(?:[-–]\d+)?$/u

/** The file a token names, or undefined when it cannot be a path: commands,
 *  URLs, globs, and bare words stay code without costing a Host round trip. */
export function parseFileToken(value: string): FileToken | undefined {
  if (value.length === 0 || value.length > MAX_TOKEN_CHARS || /[\s`*?<>|"]/u.test(value)) return undefined
  if (value.includes('://') || /^[-$~]/u.test(value)) return undefined
  const suffix = LINE_SUFFIX.exec(value)
  const path = suffix === null ? value : value.slice(0, suffix.index)
  if (!/[/\\]/u.test(path) && !/\.[A-Za-z0-9]+$/u.test(path)) return undefined
  return suffix === null ? { path } : { path, line: Number(suffix[1]) }
}

/** Every distinct inline-code token in the text. Tokens inside fences are
 *  harmless extras: the renderer only asks about inline code. */
export function inlineCodeTokens(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/`([^`\n]+)`/gu)].map(match => match[1]!))]
}

/** The Sidebar address of a path read through one Session; mirrors the
 *  Host's `sessionFileAddress`, which it does not export.
 *  ponytail: an absolute path inside the workspace keeps its absolute form, so
 *  it can open a second tab beside one opened by relative path. */
export function sessionFileAddress(sessionId: string, path: string): string {
  const encode = (segment: string): string => encodeURIComponent(segment).replace(/%3A/giu, ':')
  const normalized = path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
  return `dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`
}

/** One Session's existence answers, shared by every message in it.
 *  ponytail: answers never expire, so a token checked before its file existed
 *  stays inert until reload; Claude names files after writing them. */
export function cachedExists(stat: (path: string) => Promise<boolean>, limit = 2_000): (path: string) => Promise<boolean> {
  const answers = new Map<string, Promise<boolean>>()
  return path => {
    let answer = answers.get(path)
    if (answer === undefined) {
      if (answers.size >= limit) answers.clear()
      answer = stat(path).catch(() => false)
      answers.set(path, answer)
    }
    return answer
  }
}

/** The mentions of one settled message: undefined until a token resolves, so
 *  the renderer keeps its plain first paint. */
export function useFileMentions(
  text: string,
  source: FileMentionSource | undefined,
  label: (name: string) => string,
): FileMentions | undefined {
  const [found, setFound] = useState<ReadonlyMap<string, FileToken>>(() => new Map())
  useEffect(() => {
    if (source === undefined) return
    let live = true
    for (const value of inlineCodeTokens(text)) {
      const token = parseFileToken(value)
      if (token === undefined) continue
      void source.exists(token.path).then(ok => {
        if (!ok || !live) return
        setFound(current => (current.has(value) ? current : new Map(current).set(value, token)))
      })
    }
    return () => { live = false }
  }, [text, source])
  return useMemo(() => {
    if (source === undefined || found.size === 0) return undefined
    return {
      resolve(value) {
        const token = found.get(value)
        if (token === undefined) return undefined
        return { open: () => source.open(token.path, token.line), label: label(token.path), title: token.path }
      },
    }
  }, [found, source, label])
}
