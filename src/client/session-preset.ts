/** Which agent preset a session-list row actually runs.
 *
 *  Two sources, because Desktop moved the fact without retiring its old seat:
 *  the wire summary still declares `agentPreset`, but 2.0.4 serves every row
 *  with it unset and publishes the composed preset through the projection
 *  column instead. Reading only the summary field makes every row look
 *  preset-less — which emptied the Session board and blanked the header preset
 *  label, with nothing anywhere saying why.
 */
export interface SessionPresetRow {
  readonly agentPreset?: string
  // The projection column reports "no preset" as an explicit null, not by
  // leaving the field out.
  readonly projectionValues?: { readonly agentPreset?: string | null }
}

/**
 * Resolve one row's preset id, newest seat first.
 * @param row - a session-list row, or undefined when the id is not listed.
 * @returns the preset id, or undefined when neither source carries one.
 */
export function sessionRowPreset(row: SessionPresetRow | undefined): string | undefined {
  return row?.agentPreset ?? row?.projectionValues?.agentPreset ?? undefined
}
