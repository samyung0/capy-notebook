/* Mermaid source as shared text: the two shapes of live-items DESIGN.md
 * (section 6) against today's string attribute, through the real
 * @slate-yjs/core binding.
 *
 *   string  today: `source` is one string attribute (a live binding would
 *           rewrite it per keystroke; last write wins)
 *   nested  shape A: `source` is a Y.Text held as the element's attribute
 *           (slate-yjs patched, load.ts SHARED_TEXT_PATCH)
 *   child   shape B: a hidden `mermaid_source` text element before the
 *           caption holds the source as the block's first child (stock
 *           slate-yjs)
 *
 * Peer A edits the source the way a CodeMirror binding would (Y.Text ops on
 * the shared text, origin "cm"; for `string`, a Slate set_node per key);
 * peer B is a slate-yjs editor that must see every edit in its Slate value;
 * peer C types concurrently at another place. Writes JSON results and, for
 * the Rust prototype, each shape's base state plus every keystroke update.
 *
 * node_modules/.bin/tsx bench/collaboration/scripts/live-items/mermaid-shapes.ts <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as YT from 'yjs';
import { patchLines, type SlateEditor, slate, slateYjs, slateYjsSharedText, Y } from './load';

type Editor = SlateEditor;

type Shape = 'string' | 'nested' | 'child';
const SHAPES: Shape[] = ['string', 'nested', 'child'];

const SOURCE = `flowchart TD
  A[Learner opens the note] --> B{Has the quiz changed?}
  B -- yes --> C[Load the item's document]
  B -- no --> D[Paint the projection]
  C --> E[Sync step 1 and 2]
  D --> E
  E --> F((Editable))
  F --> G[Type in the source]
  G --> H{Valid diagram?}
  H -- yes --> I[Redraw the preview]
  H -- no --> J[Mark the blamed line]
`;
const TYPED = '  K[Another step typed live] --> L{Branch?}\n  L -- one --> M[Left]\n';
const MIDDLE = 'Concurrent!';
const OTHER = ' (edited by C)';

const para = (id: string, text: string) => ({ children: [{ text }], id, type: 'p' });

function noteValue(shape: Shape): never[] {
  const caption = { children: [{ text: 'How a live item opens' }], id: 'm1c', type: 'mermaid_caption' };
  const mermaid =
    shape === 'child'
      ? {
          children: [{ children: [{ text: SOURCE }], id: 'm1s', type: 'mermaid_source' }, caption],
          id: 'm1',
          theme: 'linear-light',
          type: 'mermaid',
          width: '80%',
        }
      : { children: [caption], id: 'm1', source: SOURCE, theme: 'linear-light', type: 'mermaid', width: '80%' };
  return [
    para('p1', 'A note with a diagram in the middle, and some text around it.'),
    mermaid,
    para('p2', 'The text after the diagram.'),
  ] as never[];
}

function binding(shape: Shape) {
  return shape === 'nested' ? slateYjsSharedText() : slateYjs;
}

/** A peer: its own Y.Doc and (optionally) a slate-yjs editor over it. */
function peer(shape: Shape, clientID: number, withEditor: boolean) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const root = doc.get('content', Y.XmlText) as YT.XmlText;
  let editor: Editor | null = null;
  if (withEditor) {
    const { withYjs, YjsEditor } = binding(shape);
    editor = withYjs(slate.createEditor() as never, root) as unknown as Editor;
    editor.isVoid = (element: unknown) => (element as { type?: string }).type === 'mermaid';
    YjsEditor.connect(editor as never);
  }
  return { doc, editor, root };
}

/** The mermaid block's source as each side holds it. */
function yjsSource(shape: Shape, root: YT.XmlText): string {
  const block = blockText(root);
  if (shape === 'child') return firstChild(block).toString();
  const value = block.getAttribute('source');
  return typeof value === 'string' ? value : (value as YT.Text).toString();
}

function slateSource(shape: Shape, editor: Editor): string {
  const node = editor.children[1] as unknown as {
    children: { children: { text: string }[] }[];
    source?: string;
  };
  return shape === 'child' ? node.children[0].children.map((leaf) => leaf.text).join('') : (node.source ?? '');
}

function blockText(root: YT.XmlText): YT.XmlText {
  const ops = root.toDelta() as { insert: unknown }[];
  return ops[1].insert as YT.XmlText;
}

function firstChild(block: YT.XmlText): YT.XmlText {
  return (block.toDelta() as { insert: unknown }[])[0].insert as YT.XmlText;
}

/** The shared text a CodeMirror binding would hold (A: the attribute; B: the child). */
function sharedText(shape: Shape, root: YT.XmlText): YT.Text {
  const block = blockText(root);
  return shape === 'child' ? firstChild(block) : (block.getAttribute('source') as YT.Text);
}

/** One keystroke at `index` (insert `text`, or delete one char when null). */
function keystroke(shape: Shape, side: ReturnType<typeof peer>, index: number, text: string | null) {
  if (shape === 'string') {
    const editor = side.editor!;
    const current = slateSource(shape, editor);
    const next = text === null ? current.slice(0, index) + current.slice(index + 1) : current.slice(0, index) + text + current.slice(index);
    slate.Transforms.setNodes(editor, { source: next } as never, { at: [1] });
    editor.onChange();
    return;
  }
  const shared = sharedText(shape, side.root);
  side.doc.transact(() => {
    if (text === null) shared.delete(index, 1);
    else shared.insert(index, text);
  }, 'cm');
}

function sync(from: YT.Doc, to: YT.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
}

/** A browser runs Slate's onChange microtask between socket messages. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function run(shape: Shape) {
  // A writes (with an editor only for `string`, which edits through Slate);
  // B renders through slate-yjs; C types concurrently.
  const a = peer(shape, 1, shape === 'string');
  const seed = new Y.Doc();
  seed.clientID = 9;
  const seedRoot = seed.get('content', Y.XmlText) as YT.XmlText;
  const { slateNodesToInsertDelta } = binding(shape);
  seedRoot.applyDelta(slateNodesToInsertDelta(noteValue(shape)), { sanitize: false });
  const base = Y.encodeStateAsUpdate(seed);
  const blockBytes = base.length;
  Y.applyUpdate(a.doc, base);
  if (a.editor) {
    // The editor connected before the seed arrived; reconnect so it reads it.
    binding(shape).YjsEditor.disconnect(a.editor as never);
    binding(shape).YjsEditor.connect(a.editor as never);
  }
  const b = peer(shape, 2, true);
  Y.applyUpdate(b.doc, base);
  binding(shape).YjsEditor.disconnect(b.editor as never);
  binding(shape).YjsEditor.connect(b.editor as never);
  const c = peer(shape, 3, shape === 'string');
  Y.applyUpdate(c.doc, base);
  if (c.editor) {
    binding(shape).YjsEditor.disconnect(c.editor as never);
    binding(shape).YjsEditor.connect(c.editor as never);
  }

  const updates: Uint8Array[] = [];
  a.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') updates.push(update);
  });
  let remoteOps = 0;
  let slateErrors = 0;
  const { apply } = b.editor!;
  b.editor!.apply = (op: unknown) => {
    remoteOps += 1;
    apply(op);
  };
  const deliver = async () => {
    await tick();
    try {
      sync(a.doc, b.doc);
    } catch {
      slateErrors += 1;
    }
    await tick();
  };

  // 1. A types TYPED at the end, one transaction per key; B follows each.
  let at = SOURCE.length;
  for (const char of TYPED) {
    keystroke(shape, a, at, char);
    at += 1;
    await deliver();
  }
  const typedOk = slateSource(shape, b.editor!) === yjsSource(shape, a.root) || shape === 'string';
  // 2. Ten backspaces.
  for (let i = 0; i < 10; i++) {
    at -= 1;
    keystroke(shape, a, at, null);
    await deliver();
  }
  // 3. A and C type at once (no sync in between): A in the middle, C at the start.
  const mid = Math.floor(SOURCE.length / 2);
  sync(a.doc, c.doc);
  for (let i = 0; i < MIDDLE.length; i++) {
    keystroke(shape, a, mid + i, MIDDLE[i]);
    keystroke(shape, c, 13 + i, OTHER[i] ?? '');
    await tick();
  }
  sync(c.doc, a.doc);
  sync(a.doc, c.doc);
  await deliver();
  sync(c.doc, b.doc);
  await tick();

  const finalA = yjsSource(shape, a.root);
  const finalC = yjsSource(shape, c.root);
  const finalB = slateSource(shape, b.editor!);
  const merged = finalA.includes(MIDDLE) && finalA.includes(OTHER.slice(0, MIDDLE.length));
  let firstDifference: number | null = null;
  if (finalB !== finalA) {
    firstDifference = 0;
    while (finalA[firstDifference] === finalB[firstDifference]) firstDifference++;
  }

  // 4. B moves the block above the first paragraph (slate-yjs clones it).
  let moved = 'n/a';
  try {
    slate.Transforms.moveNodes(b.editor!, { at: [1], to: [0] });
    await tick();
    sync(b.doc, a.doc);
    const block = (a.root.toDelta() as { insert: YT.XmlText }[])[0].insert;
    const source =
      shape === 'child'
        ? firstChild(block).toString()
        : String(block.getAttribute('source'));
    const kind =
      shape === 'nested' ? (block.getAttribute('source') instanceof Y.Text ? 'Y.Text' : typeof block.getAttribute('source')) : 'n/a';
    moved = source === finalB ? `kept (${kind})` : 'lost';
  } catch (error) {
    moved = `threw: ${(error as Error).message}`;
  }

  // Stored state after the session: a fresh GC'd doc holding everything.
  const stored = new Y.Doc();
  Y.applyUpdate(stored, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(stored, Y.encodeStateAsUpdate(c.doc));
  const storedBytes = Y.encodeStateAsUpdate(stored).length;
  const keyUpdates = updates.slice(0, TYPED.length + 10);
  const perKey = keyUpdates.reduce((sum, update) => sum + update.length, 0) / keyUpdates.length;
  return {
    base,
    result: {
      shape,
      blockBaseBytes: blockBytes,
      bytesPerKeystroke: Number(perKey.toFixed(1)),
      bytesPerKeystrokeMax: Math.max(...keyUpdates.map((u) => u.length)),
      concurrentMerged: merged,
      convergedAC: finalA === finalC,
      convergedSlateB: finalB === finalA,
      slateBDifference:
        firstDifference === null
          ? null
          : { a: finalA.slice(firstDifference - 5, firstDifference + 15), at: firstDifference, b: finalB.slice(firstDifference - 5, firstDifference + 15) },
      moveBlock: moved,
      remoteSlateOpsPerKeystroke: Number((remoteOps / (TYPED.length + 10 + 1)).toFixed(2)),
      slateErrors,
      sourceChars: finalA.length,
      storedBytesAfterSession: storedBytes,
      typedVisibleToB: typedOk,
    },
    updates: keyUpdates,
  };
}

/** Today's unpatched slate-yjs given a nested source: what breaks. */
function stockOnNested() {
  const seed = new Y.Doc();
  const root = seed.get('content', Y.XmlText) as YT.XmlText;
  root.applyDelta(slateYjsSharedText().slateNodesToInsertDelta(noteValue('nested')), { sanitize: false });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  const editor = slateYjs.withYjs(slate.createEditor() as never, doc.get('content', Y.XmlText) as YT.XmlText) as unknown as Editor;
  slateYjs.YjsEditor.connect(editor as never);
  const read = typeof (editor.children[1] as unknown as { source: unknown }).source;
  let remote = 'applied';
  try {
    const shared = sharedText('nested', root);
    seed.transact(() => shared.insert(0, '%% '), 'cm');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed, Y.encodeStateVector(doc)));
  } catch (error) {
    remote = `threw: ${(error as Error).message}`;
  }
  return { readsSourceAs: read, remoteEdit: remote };
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: mermaid-shapes.ts <outDir>');
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const shape of SHAPES) {
    const { base, result, updates } = await run(shape);
    results.push(result);
    writeFileSync(join(out, `${shape}.base.bin`), base);
    // Length-prefixed (u32 LE) keystroke updates, in order.
    const chunks = updates.flatMap((update) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(update.length);
      return [length, Buffer.from(update)];
    });
    writeFileSync(join(out, `${shape}.updates.bin`), Buffer.concat(chunks));
  }
  const report = {
    patchLinesShapeA: patchLines(),
    results,
    stockSlateYjsOnShapeA: stockOnNested(),
  };
  writeFileSync(join(out, 'mermaid-shapes.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
