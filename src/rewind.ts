/** Rewind: drop one user message and everything after it.
 *
 *  Two halves, because the two sides of a Claude session are owned by
 *  different processes:
 *
 *  - Claude's own transcript is rewound for real. Every completed DSH turn
 *    records the last chain-entry uuid Claude emitted for it, so the next
 *    spawn resumes at the kept turn's anchor (`resumeSessionAt`) and the model
 *    genuinely forgets the discarded turns.
 *  - The DSH session log is append-only and the Host renders every event it
 *    holds — even compaction keeps the shadowed conversation on screen — so the
 *    discarded rows are recorded here as hidden seq ranges and suppressed by
 *    the browser instead of deleted.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One inclusive span of hidden surface seqs. */
export interface ClaudeRewindRange {
  readonly start: number
  readonly end: number
}

/** The last Claude chain entry of one completed DSH turn. */
export interface ClaudeRewindAnchor {
  readonly turn: number
  readonly uuid: string
}

/** Fork target for the next Claude spawn; `fresh` starts an empty session. */
export type ClaudeRewindResume = { readonly resumeAt: string } | { readonly fresh: true }

export interface ClaudeRewindState {
  /** Hidden seq ranges, ascending and non-overlapping. */
  readonly ranges: readonly ClaudeRewindRange[]
  /** Chain anchors of the turns Claude still holds, ascending by turn. */
  readonly anchors: readonly ClaudeRewindAnchor[]
  /** Armed once by a rewind, consumed by the next Claude spawn. */
  readonly pending?: ClaudeRewindResume
}

export const EMPTY_REWIND_STATE: ClaudeRewindState = { ranges: [], anchors: [] }

/** Sessions outlive their rewinds; both lists stay bounded. */
export const MAX_REWIND_RANGES = 200
export const MAX_REWIND_ANCHORS = 2_000

/** Absorb one span into an ascending, non-overlapping range list. Adjacent
 *  spans merge so a rewind of a rewind reads as one hidden block. */
export function mergeRewindRanges(
  ranges: readonly ClaudeRewindRange[],
  addition: ClaudeRewindRange,
): ClaudeRewindRange[] {
  const merged: ClaudeRewindRange[] = []
  let { start, end } = addition
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    if (range.end + 1 < start) merged.push(range)
    else if (range.start > end + 1) {
      merged.push({ start, end })
      start = range.start
      end = range.end
    } else {
      start = Math.min(start, range.start)
      end = Math.max(end, range.end)
    }
  }
  merged.push({ start, end })
  return merged.slice(-MAX_REWIND_RANGES)
}

export function isRewound(ranges: readonly ClaudeRewindRange[], seq: number): boolean {
  return ranges.some(range => seq >= range.start && seq <= range.end)
}

/** Record one completed turn's last chain entry, replacing a re-run turn. */
export function recordRewindAnchor(
  state: ClaudeRewindState,
  anchor: ClaudeRewindAnchor,
): ClaudeRewindState {
  const anchors = [...state.anchors.filter(item => item.turn !== anchor.turn), anchor]
    .sort((left, right) => left.turn - right.turn)
    .slice(-MAX_REWIND_ANCHORS)
  return { ...state, anchors }
}

/** The turn a surface seq belongs to: the first turn opened at or after it.
 *  A message accepted but never run belongs to no logged turn, so nothing
 *  Claude holds is discarded and every anchor stays valid. */
export function turnAtOrAfter(events: readonly SessionEvent[], seq: number): number | undefined {
  for (const event of events) {
    if (event.seq >= seq && event.type === 'turn/start') return event.data.turn
  }
  return undefined
}

/** Plan one rewind at `seq`, or undefined when the seq is not in the log.
 *  Anchors of the discarded turns go with them: after this rewind Claude no
 *  longer holds those entries, so a later rewind must never fork at one. */
export function planRewind(
  state: ClaudeRewindState,
  events: readonly SessionEvent[],
  seq: number,
): ClaudeRewindState | undefined {
  const last = events.at(-1)?.seq
  if (last === undefined || seq > last) return undefined
  const turn = turnAtOrAfter(events, seq) ?? Number.MAX_SAFE_INTEGER
  const anchors = state.anchors.filter(anchor => anchor.turn < turn)
  const kept = anchors.at(-1)
  return {
    ranges: mergeRewindRanges(state.ranges, { start: seq, end: last }),
    anchors,
    pending: kept === undefined ? { fresh: true } : { resumeAt: kept.uuid },
  }
}
