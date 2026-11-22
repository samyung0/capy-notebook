/** What readers and validators take of a count or a text length that two
 * people's edits at the same moment can merge past (Epo 2026-11-22, "Yes, A
 * everywhere"): twice its cap. Editors stop at the cap itself, checked against
 * the document as it reads when written; a value past it comes from a merge, a
 * hand-made client, or a paste or Duplicate of a block holding one (a figure,
 * Mermaid diagram or table view keeps what it holds). Past twice it is
 * refused. Go's `fieldlimits.Merged` and the collaboration server's
 * `limits::merged_cap` are the same. */
export const mergedCap = (cap: number) => 2 * cap;

/** Whether an editor's edit goes back: it takes a text's length (or a list's
 * count) from `held` to `next`, past the cap and longer than it was. One a
 * merge took past the cap still takes edits that do not lengthen it. */
export const passesCap = (next: number, held: number, cap: number) =>
  next > cap && next > held;
