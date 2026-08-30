/** The agent-preset roster, read for the Session header label.
 *
 *  This plugin shadows the Host's own header label (to swap the native `title`
 *  popup for the DSH tooltip bubble and to brand the Claude preset), and a
 *  shadow renders in every Session, not just plugin-owned ones. So the roster
 *  read and the display-name resolution both have to match the Host's exactly,
 *  or replacing the label would quietly downgrade every other preset's name.
 */

/** The roster fields the label reads. Declared structurally rather than
 *  imported from the apiproxy package's deep path: this is a wire shape, and
 *  the label only ever reads these four. */
export interface AgentPresetRow {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly name?: string
  readonly description?: string
}

/** Display copy for one preset. */
export interface PresetDisplayText {
  readonly name: string
  readonly description?: string
}

/** Locale keys the Host uses for the presets it ships, mirrored so a shadowed
 *  label still shows their translated copy instead of a bare id. Every entry is
 *  a lookup into the Host's own `settings.agentPreset` namespace; an id absent
 *  here (this plugin's preset included) falls through to file metadata, which
 *  is what the Host does too. */
const BUILT_IN_KEYS: Readonly<Record<string, { readonly name: string; readonly description: string }>> = {
  standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
  code: { name: 'presetCodeName', description: 'presetCodeDescription' },
  minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
  cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
}

/** A locale lookup that reports a miss by echoing the key back. */
export type HostTranslate = (key: string) => string

/**
 * Resolve one preset's display copy the way the Host does: translated copy for
 * a preset it ships, file metadata otherwise.
 * @param row - the roster row, or undefined when the roster has not arrived.
 * @param presetId - the id recorded on the session.
 * @param hostT - lookup bound to the Host's preset namespace.
 * @returns the name to render and the description to put in the tooltip.
 */
export function presetDisplayText(row: AgentPresetRow | undefined, presetId: string, hostT: HostTranslate): PresetDisplayText {
  const keys = row?.trust === 'system' ? BUILT_IN_KEYS[row.id] : undefined
  if (keys !== undefined) {
    const name = hostT(keys.name)
    const description = hostT(keys.description)
    // A missing dictionary entry echoes its key; that is not display copy.
    if (name !== keys.name) return { name, ...(description === keys.description ? {} : { description }) }
  }
  return {
    name: row?.name ?? presetId,
    ...(row?.description === undefined ? {} : { description: row.description }),
  }
}

/** The roster read, published as a snapshot source. */
export interface AgentPresetRosterApi {
  list(): Promise<{ ok: true; value: { presets: readonly AgentPresetRow[] } } | { ok: false }>
}

export class AgentPresetRoster {
  readonly #api: AgentPresetRosterApi
  readonly #listeners = new Set<() => void>()
  #rows: readonly AgentPresetRow[] = []
  #inflight: Promise<void> | undefined

  constructor(api: AgentPresetRosterApi) {
    this.#api = api
  }

  /** Read the roster once. Concurrent calls share the in-flight read, and a
   *  failed read leaves the previous rows in place — the label falls back to
   *  the session's preset id, never to an empty header. */
  load(): void {
    if (this.#inflight !== undefined) return
    this.#inflight = (async () => {
      try {
        const response = await this.#api.list()
        if (!response.ok) return
        this.#rows = response.value.presets
        for (const listener of this.#listeners) listener()
      } catch {
        // A roster that never arrives is a naming downgrade, not an error the
        // header can act on.
      } finally {
        this.#inflight = undefined
      }
    })()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): readonly AgentPresetRow[] => this.#rows
}
