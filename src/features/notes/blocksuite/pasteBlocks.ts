import { z } from 'zod/v4';
import type { MaterialValue } from '@/features/materials/document';
import { markdownToDocument } from '@/features/notes/markdownConvert';
import { CALLOUT_VARIANTS } from '@/features/notes/richBlockConfig';
import type { CopiedBlock } from '@/features/workspace/chat/answerClipboard';
import { type BlocksJson, isTextProp, NOTE_ID, valueToBlocks } from './layout';

/* What a paste into the BlockSuite note inserts (D17): text through our
 * markdown converter, then layout.ts's Plate-to-blocks step, as BlockSuite
 * block snapshots for its clipboard to insert at the selection. */

/** BlockSuite's `BlockSnapshot`, as JSON. */
export interface BlockSnapshotJson {
  children: BlockSnapshotJson[];
  flavour: string;
  id: string;
  props: Record<string, unknown>;
  type: 'block';
  version: number;
}

/** BlockSuite's marker for a `Text` prop in a snapshot (TEXT_UNIQ_IDENTIFIER). */
const TEXT = '$blocksuite:internal:text$';

const textJson = (delta: unknown) => ({ [TEXT]: true, delta });

/** A flat-data block's dotted keys as the nested props `addBlock` takes. */
function nestFlat(flavour: string, props: Record<string, unknown>) {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    const path = key.split('.');
    let target = nested;
    for (const part of path.slice(0, -1)) {
      target[part] ??= {};
      target = target[part] as Record<string, unknown>;
    }
    target[path.at(-1) as string] = isTextProp(flavour, key)
      ? textJson(value)
      : value;
  }
  return nested;
}

function snapshot(blocks: BlocksJson, id: string): BlockSnapshotJson {
  const { children, flavour, props, version } = blocks[id];
  return {
    children: children.map((child) => snapshot(blocks, child)),
    flavour,
    // Converted blocks are new: none keeps the id the converter derived.
    id: crypto.randomUUID(),
    props:
      flavour === 'affine:table'
        ? nestFlat(flavour, props)
        : Object.fromEntries(
            Object.entries(props).map(([key, value]) => [
              key,
              isTextProp(flavour, key) ? textJson(value) : value,
            ])
          ),
    type: 'block',
    version,
  };
}

/** A Plate value's blocks, top level first, as snapshots. */
export function valueSnapshots(value: MaterialValue): BlockSnapshotJson[] {
  const blocks = valueToBlocks(value);
  return blocks[NOTE_ID].children.map((id) => snapshot(blocks, id));
}

/** Pasted Markdown, read as today's paste reads it: MDX on. */
export function markdownSnapshots(markdown: string) {
  return valueSnapshots(markdownToDocument(markdown).value);
}

const copiedAnswer: z.ZodType<CopiedBlock[]> = z.array(
  z.object({
    callout: z
      .enum(CALLOUT_VARIANTS.map((variant) => variant.value))
      .optional(),
    md: z.string(),
  })
);

/** A chat answer's copy (answerClipboard.ts): each block's Markdown read as
 * the agent's (no MDX), callouts wrapped in a callout of their variant.
 * Throws when the copy or a block does not read. */
export function answerSnapshots(raw: string) {
  const value = copiedAnswer
    .parse(JSON.parse(raw))
    .flatMap(({ callout, md }): MaterialValue => {
      const blocks = markdownToDocument(md, { plain: true }).value;
      return callout
        ? [{ children: blocks, type: 'callout', variant: callout }]
        : blocks;
    });
  return valueSnapshots(value);
}
