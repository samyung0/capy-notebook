/* The live editor stops indenting a block at the catalog's LIST_INDENT_MAX
   (Epo 2026-10-18), the deepest indent Go and the collaboration server store. */
import { createPlateEditor } from 'platejs/react';
import { expect, it } from 'vitest';
import { LIST_INDENT_MAX } from '@/features/materials/document';
import { buildPlugins } from './plugins';

it('stops Tab at LIST_INDENT_MAX', () => {
  const editor = createPlateEditor({
    plugins: buildPlugins({
      allowExternalAssets: false,
      currentUserId: null,
      discussions: [],
      onSave: () => {},
      workspaceId: 'w',
    }),
    value: [
      {
        children: [{ text: 'deep' }],
        id: 'l1',
        indent: 1,
        listStyleType: 'disc',
        type: 'p',
      },
    ],
  });
  editor.tf.select({ offset: 0, path: [0, 0] });
  for (let press = 0; press < LIST_INDENT_MAX + 2; press++)
    editor.tf.tab({ reverse: false });
  expect(editor.children[0]).toMatchObject({ indent: LIST_INDENT_MAX });
});
