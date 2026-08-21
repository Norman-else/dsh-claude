import { useEffect, useMemo, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'

export interface ClaudeDiffPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
}

export interface ClaudeDiffPanelProps extends ClaudeDiffPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export interface DiffFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly lines: readonly string[]
}

function pathFromHeader(line: string): string | undefined {
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
  return match?.[2]
}

export function parseUnifiedDiff(patch: string): readonly DiffFile[] {
  const files: DiffFile[] = []
  let path: string | undefined
  let lines: string[] = []
  const flush = (): void => {
    if (path === undefined) return
    const content = lines.filter(line => !line.startsWith('diff --git ') && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ '))
    files.push({
      path,
      additions: content.filter(line => line.startsWith('+')).length,
      deletions: content.filter(line => line.startsWith('-')).length,
      lines: content,
    })
  }
  for (const line of patch.split(/\r?\n/u)) {
    const nextPath = pathFromHeader(line)
    if (nextPath !== undefined) {
      flush()
      path = nextPath
      lines = [line]
    } else if (path !== undefined) lines.push(line)
  }
  flush()
  return files
}

interface NumberedDiffLine {
  readonly line: string
  readonly kind: 'add' | 'delete' | 'hunk' | 'context' | 'collapsed'
  readonly oldLine?: number
  readonly newLine?: number
}

export function numberDiffLines(lines: readonly string[]): readonly NumberedDiffLine[] {
  const numbered: NumberedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let previousOldEnd: number | undefined
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (hunk !== null) {
      const nextOld = Number(hunk[1])
      if (previousOldEnd !== undefined && nextOld > previousOldEnd) {
        numbered.push({ line: `${nextOld - previousOldEnd} unmodified lines`, kind: 'collapsed' })
      }
      oldLine = nextOld
      newLine = Number(hunk[3])
      previousOldEnd = nextOld + Number(hunk[2] ?? 1)
      numbered.push({ line, kind: 'hunk' })
      continue
    }
    if (line.startsWith('+')) {
      numbered.push({ line, kind: 'add', newLine })
      newLine += 1
    } else if (line.startsWith('-')) {
      numbered.push({ line, kind: 'delete', oldLine })
      oldLine += 1
    } else {
      numbered.push({ line, kind: 'context', oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  return numbered
}

function DiffLine({ entry }: { entry: NumberedDiffLine }) {
  const style = entry.kind === 'add'
    ? styles.diffLineAdd
    : entry.kind === 'delete' ? styles.diffLineDelete : entry.kind === 'hunk' || entry.kind === 'collapsed' ? styles.diffLineHunk : styles.diffLineContext
  const lineNumber = entry.oldLine === undefined && entry.newLine === undefined
    ? ''
    : entry.oldLine === undefined ? String(entry.newLine) : entry.newLine === undefined ? String(entry.oldLine) : String(entry.newLine)
  return <div style={{ ...styles.diffLine, ...style }}><span style={styles.diffLineNumber}>{lineNumber}</span><span style={styles.diffLineMarker}>{entry.kind === 'add' ? '+' : entry.kind === 'delete' ? '−' : entry.kind === 'collapsed' ? '⌄' : ' '}</span><span>{entry.kind === 'collapsed' ? entry.line : entry.line.slice(entry.kind === 'hunk' ? 0 : 1)}</span></div>
}

function DiffFileSection({ file, initiallyOpen }: { file: DiffFile; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <section style={styles.diffFile}>
      <button type="button" style={styles.diffFileHeader} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span style={{ ...styles.chevron, ...(open ? styles.chevronOpen : {}) }}>›</span>
        <span style={styles.diffFilePath}>{file.path}</span>
        <span style={styles.diffFileStats}><span style={styles.diffAdd}>+{file.additions}</span><span style={styles.diffDelete}>−{file.deletions}</span></span>
      </button>
      {open ? <div style={styles.diffCode}>{numberDiffLines(file.lines).map((entry, index) => <DiffLine key={`${index}:${entry.line}`} entry={entry} />)}</div> : null}
    </section>
  )
}

export function ClaudeDiffPanel({ useClaudeProjection, t, closeDetails }: ClaudeDiffPanelProps) {
  const projection = useClaudeProjection(value => value)
  const repository = projection.repository
  const diff = repository?.diff
  const files = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])
  useEffect(() => {
    if (!projection.owned || repository?.status !== 'ready' || diff === undefined) closeDetails()
  }, [closeDetails, diff, projection.owned, repository?.status])
  if (!projection.owned || repository?.status !== 'ready' || diff === undefined) return null
  const branch = repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch')
  return (
    <div style={styles.diffPanel}>
      <header style={styles.diffHeader}>
        <div style={styles.diffHeaderTitle}><span style={styles.diffHeaderBranch}>{branch}</span><span aria-hidden="true">›</span><span>{t('diffWorkingTree')}</span></div>
        <button type="button" style={styles.tasksClose} aria-label={t('diffClose')} onClick={closeDetails}>×</button>
      </header>
      <div style={styles.diffSummary}>
        <span>{t('diffFiles', { count: diff.files })}</span>
        <span style={styles.diffAdd}>+{diff.additions}</span>
        <span style={styles.diffDelete}>−{diff.deletions}</span>
      </div>
      <div style={styles.diffBody}>
        {diff.truncated ? <p style={styles.diffNotice}>{t('diffTruncated')}</p> : null}
        {files.length === 0 ? <p style={styles.diffEmpty}>{t('diffEmpty')}</p> : files.map((file, index) => (
          <DiffFileSection key={file.path} file={file} initiallyOpen={index === 0} />
        ))}
      </div>
    </div>
  )
}
