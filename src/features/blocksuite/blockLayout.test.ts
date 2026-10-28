import {
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine/model';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

// The vendored BlockSuite store writes a note into a Y.Doc made by our
// (patched) yjs, in the layout the converters and the room will rely on.
describe('BlockSuite store layout', () => {
  it('writes page → note → paragraph as sys:/prop: keys in the blocks map', () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
    ];
    workspace.meta.initialize();
    const store = workspace.createDoc('note').getStore();
    let paragraphId = '';
    store.load(() => {
      const pageId = store.addBlock('affine:page', { title: new Text('T') });
      const noteId = store.addBlock('affine:note', {}, pageId);
      paragraphId = store.addBlock(
        'affine:paragraph',
        { text: new Text('hello') },
        noteId
      );
    });

    const doc = store.doc.spaceDoc;
    expect(doc).toBeInstanceOf(Y.Doc);
    const blocks = doc.getMap('blocks');
    expect(blocks.size).toBe(3);

    const paragraph = blocks.get(paragraphId) as Y.Map<unknown>;
    expect(paragraph.get('sys:id')).toBe(paragraphId);
    expect(paragraph.get('sys:flavour')).toBe('affine:paragraph');
    expect(paragraph.get('sys:version')).toBeTypeOf('number');
    expect(paragraph.get('sys:children')).toBeInstanceOf(Y.Array);
    expect(paragraph.get('prop:type')).toBe('text');
    const text = paragraph.get('prop:text');
    expect(text).toBeInstanceOf(Y.Text);
    expect((text as Y.Text).toString()).toBe('hello');

    const flavours = [...blocks.values()].map((block) =>
      (block as Y.Map<unknown>).get('sys:flavour')
    );
    expect(flavours.sort()).toEqual([
      'affine:note',
      'affine:page',
      'affine:paragraph',
    ]);
    const note = [...blocks.values()].find(
      (block) => (block as Y.Map<unknown>).get('sys:flavour') === 'affine:note'
    ) as Y.Map<unknown>;
    expect((note.get('sys:children') as Y.Array<string>).toArray()).toEqual([
      paragraphId,
    ]);
  });
});
