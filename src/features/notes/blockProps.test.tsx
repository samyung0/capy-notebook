/* What each block of the note editor draws from the props and wrappers that
   read through the editor rendering it (not Plate's per-element store hooks):
   the selectable class, the trailing hint folded into the block placeholder
   (plugins.ts, trailingHint.ts), the selection overlay (BlockSelection.tsx)
   and the ghost text (GhostTextView.tsx). */
import { CopilotPlugin } from '@platejs/ai/react';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { parseHTML } from 'linkedom';
import {
  BlockPlaceholderPlugin,
  createPlateEditor,
  Plate,
  PlateContent,
  type PlateEditor,
} from 'platejs/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { noteComponents } from './nodeComponents';
import { buildPlugins } from './plugins';
import { PLACEHOLDER_CLASS, trailingHintPlugin } from './trailingHint';

/** The editor's server render after `setUp`, as a block lookup by id.
 * `options` are plugins' initial options, by plugin key. */
function render(
  setUp: (editor: PlateEditor) => void,
  options: Record<string, object> = {}
) {
  const plugins = buildPlugins({
    allowExternalAssets: true,
    currentUserId: null,
    discussions: [],
    onSave: () => {},
    workspaceId: 'w',
  }).map((plugin) =>
    // A server render reads a plain option's initial value, not a later
    // one. `extend`, as `configure` would replace the kit's own.
    options[plugin.key]
      ? plugin.extend({ options: options[plugin.key] })
      : plugin
  );
  const editor = createPlateEditor({
    components: noteComponents,
    nodeId: false,
    plugins,
    value: [
      { children: [{ text: 'Title' }], id: 'a', type: 'h1' },
      { children: [{ text: 'Body' }], id: 'b', type: 'p' },
      { children: [{ text: '' }], id: 'c', type: 'p' },
    ],
  });
  setUp(editor);
  const { document } = parseHTML(
    `<!doctype html><html><body>${renderToStaticMarkup(
      <Plate editor={editor}>
        <PlateContent />
      </Plate>
    )}</body></html>`
  );
  // In order: a server render has no `data-block-id` (a ref sets it).
  const blocks = document.querySelectorAll('[data-slate-node="element"]');
  return (id: 'a' | 'b' | 'c') => blocks[['a', 'b', 'c'].indexOf(id)];
}

const classes = (element: Element) =>
  (element.getAttribute('class') ?? '').split(' ');

it('marks blocks selectable and draws the trailing hint on the empty last paragraph', () => {
  const block = render((editor) =>
    editor.setOption(trailingHintPlugin, 'last', editor.children[2])
  );

  for (const id of ['a', 'b'] as const)
    expect(classes(block(id))).toContain('slate-selectable');
  // Not the note's empty last paragraph (BlockSelectionPlugin's isSelectable).
  expect(classes(block('c'))).not.toContain('slate-selectable');
  expect(block('c').getAttribute('placeholder')).toBe(m.editor_placeholder());
  expect(classes(block('c'))).toEqual(
    expect.arrayContaining(PLACEHOLDER_CLASS.split(' '))
  );
});

it("gives the focused empty block the hint's classes and the block placeholder's, with its text", () => {
  const block = render((editor) => {
    editor.setOption(trailingHintPlugin, 'last', editor.children[2]);
    editor.setOption(BlockPlaceholderPlugin, '_target', {
      node: editor.children[2],
      placeholder: 'Focused',
    });
    // The kit gives both the same classes; the placeholder's own here, so
    // the merge shows (read with `getOption`, so the render sees it).
    editor.setOption(
      BlockPlaceholderPlugin,
      'className',
      'focused-placeholder'
    );
  });

  expect(block('c').getAttribute('placeholder')).toBe('Focused');
  expect(classes(block('c'))).toEqual(
    expect.arrayContaining([
      ...PLACEHOLDER_CLASS.split(' '),
      'focused-placeholder',
    ])
  );
});

it("draws a selected block's overlay and the ghost text under its block", () => {
  const block = render(
    (editor) =>
      editor.setOption(BlockSelectionPlugin, 'selectedIds', new Set(['b'])),
    {
      [CopilotPlugin.key]: {
        suggestionNodeId: 'b',
        suggestionText: ' and more',
      },
    }
  );

  expect(block('b').querySelector('[data-slot="block-selection"]')).not.toBe(
    null
  );
  expect(block('b').textContent).toContain(' and more');
});
