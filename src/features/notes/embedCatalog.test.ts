/* The browser against the embed catalog (openwiki/embeds.md): the read-only
   plugin kit and the live editor know every element type with the catalog's
   void and inline flags, chat has each embed's component, every embed's fence converts
   to its element and back, and every element names its index rule. */
import { readFileSync } from 'node:fs';
import { serializeMd } from '@platejs/markdown';
import { createSlateEditor, type SlateEditor } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { noteMarkdownPlugin } from './markdown';
import { markdownToDocument } from './markdownConvert';
import { buildPlugins } from './plugins';

function question(name: string) {
  const file = new URL(
    `../../../server/internal/questions/testdata/${name}.json`,
    import.meta.url
  );
  return JSON.parse(readFileSync(file, 'utf8')).question;
}

const rich = question('rich-blocks');
/** A fence body for each embed kind; a kind added to the catalog needs one. */
const bodies: Record<string, string> = {
  chart: JSON.stringify(rich.stem[2]),
  flashcards: 'cards:\n  - {front: Osmosis, back: Water across a membrane}',
  graph: JSON.stringify(rich.stem[1]),
  html_embed: 'caption: A slider\nhtml: |\n  <input type="range">',
  mermaid: 'flowchart LR\n  A --> B',
  plot: JSON.stringify(question('plot').stem[1]),
  quiz: 'questions: []',
};

const flags = (node: { isInline?: boolean; isVoid?: boolean }) =>
  `${node.isVoid ? 'void' : 'block'}${node.isInline ? ' inline' : ''}`;

/** Each element type an editor's plugins register, with its flags. */
function elementFlags(editor: SlateEditor) {
  const kit: Record<string, string> = {};
  for (const plugin of Object.values(editor.plugins))
    if (plugin.node.isElement)
      kit[plugin.node.type ?? plugin.key] = flags(plugin.node);
  return kit;
}

const catalogFlags = Object.fromEntries(
  EMBED_CATALOG.elements.map((element) => [
    element.type,
    flags({
      isInline: 'inline' in element && element.inline,
      isVoid: 'void' in element && element.void,
    }),
  ])
);

describe('the embed catalog', () => {
  const editor = createSlateEditor({
    plugins: [...StaticMaterialKit, noteMarkdownPlugin],
  });

  it('is what the read-only plugin kit knows', () => {
    expect(elementFlags(editor)).toEqual(catalogFlags);
  });

  it.each([true, false])(
    'is what the live editor knows (AI plugins %s)',
    (allowExternalAssets) => {
      const live = createPlateEditor({
        plugins: buildPlugins({
          allowExternalAssets,
          currentUserId: null,
          discussions: [],
          onSave: () => {},
          workspaceId: 'w',
        }),
      });
      // The editor draws a Mermaid block as a void, its caption an input
      // field (blocks/elements.tsx); the stored node holds the caption child.
      expect(elementFlags(live)).toEqual({ ...catalogFlags, mermaid: 'void' });
    }
  );

  // Go's ExtractIndexText and the collaboration server's index_text read
  // each element's rule (openwiki/embeds.md "Index text").
  it('gives every element an index rule', () => {
    const rules = ['none', 'text', 'figure', 'mermaid', 'question', 'item'];
    for (const element of EMBED_CATALOG.elements)
      expect(rules, element.type).toContain(element.index);
  });

  it('names chat components the chat library has', () => {
    const file = new URL(
      '../../../pipeline/pipeline/generated/openui_library.json',
      import.meta.url
    );
    const library = JSON.parse(readFileSync(file, 'utf8')) as {
      components: { name: string }[];
    };
    const components = library.components.map((c) => c.name);
    for (const embed of EMBED_CATALOG.embeds)
      if ('chat' in embed) expect(components).toContain(embed.chat);
  });

  it.each(EMBED_CATALOG.embeds.map((embed) => [embed.kind, embed] as const))(
    'reads and writes a %s fence',
    (kind, embed) => {
      const body = bodies[kind];
      expect(body, `a ${kind} fence body`).toBeDefined();
      const fence = `\`\`\`${embed.fence.lang}\n${body}\n\`\`\``;
      const [node] = markdownToDocument(fence).value;
      expect(node.type).toBe(embed.element);
      if (embed.class === 'item') expect(node.refKind).toBe(kind);
      expect(serializeMd(editor, { value: [node] })).toContain(
        `\`\`\`${embed.fence.lang}\n`
      );
    }
  );
});
