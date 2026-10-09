import { BaseYjsPlugin } from '@platejs/yjs';
import { slateNodesToInsertDelta, YjsEditor } from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { remoteNormalizationPlugin } from './remoteNormalization';

type Paragraph = { children: { text: string }[] };

/** The first paragraph's text of a room. */
function roomText(doc: Y.Doc) {
  const [block] = doc.get('content', Y.XmlText).toDelta() as {
    insert: Y.XmlText;
  }[];
  return block.insert.toString();
}

/** A peer edits a one-paragraph room; a Plate editor bound to its own copy
 * (YjsPlugin first, as the note editor) takes each of the peer's updates,
 * all in one task (`burst`) or each in its own. */
async function run(burst: boolean, plugins: unknown[]) {
  const peer = new Y.Doc();
  peer
    .get('content', Y.XmlText)
    .applyDelta(
      slateNodesToInsertDelta([
        { children: [{ text: 'abc' }], id: 'p1', type: 'p' },
      ] as never),
      { sanitize: false }
    );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [BaseYjsPlugin.configure({ options: { ydoc: doc } }), ...plugins],
  } as never);
  YjsEditor.connect(editor as never);
  const [block] = peer.get('content', Y.XmlText).toDelta() as {
    insert: Y.XmlText;
  }[];
  const text = block.insert;
  const receive = () =>
    Y.applyUpdate(
      doc,
      Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)),
      'room'
    );
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Typing at the end of the leaf makes Slate-Yjs insert a new leaf, which
  // the editor's normalization merges as a local operation.
  text.insert(3, 'K');
  receive();
  if (!burst) await nextTask();
  text.insert(4, 'L');
  receive();
  if (!burst) await nextTask();
  text.delete(4, 1);
  receive();
  await nextTask();
  const shown = (editor.children[0] as Paragraph).children
    .map((leaf) => leaf.text)
    .join('');
  return { local: roomText(doc), peer: roomText(peer), shown };
}

it('keeps the editor, its room copy and the peer equal when remote updates arrive in one task', async () => {
  const same = { local: 'abcK', peer: 'abcK', shown: 'abcK' };
  expect(await run(false, [remoteNormalizationPlugin])).toEqual(same);
  expect(await run(true, [remoteNormalizationPlugin])).toEqual(same);
});
