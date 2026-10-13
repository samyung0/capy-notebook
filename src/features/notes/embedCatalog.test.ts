/* The browser against the embed catalog (openwiki/embeds.md): the read-only
   plugin kit knows every element type with the catalog's void and inline
   flags, and every embed's fence converts to its element and back. */
import { readFileSync } from 'node:fs';
import { serializeMd } from '@platejs/markdown';
import { createSlateEditor } from 'platejs';
import { describe, expect, it } from 'vitest';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { noteMarkdownPlugin } from './markdown';
import { markdownToDocument } from './markdownConvert';

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

describe('the embed catalog', () => {
  const editor = createSlateEditor({
    plugins: [...StaticMaterialKit, noteMarkdownPlugin],
  });

  it('is what the read-only plugin kit knows', () => {
    const flags = (node: { isInline?: boolean; isVoid?: boolean }) =>
      `${node.isVoid ? 'void' : 'block'}${node.isInline ? ' inline' : ''}`;
    const kit = new Map<string, string>();
    for (const plugin of Object.values(editor.plugins)) {
      if (plugin.node.isElement)
        kit.set(plugin.node.type ?? plugin.key, flags(plugin.node));
    }
    const catalog = new Map<string, string>(
      EMBED_CATALOG.elements.map((element) => [
        element.type,
        flags({
          isInline: 'inline' in element && element.inline,
          isVoid: 'void' in element && element.void,
        }),
      ])
    );
    expect(Object.fromEntries(kit)).toEqual(Object.fromEntries(catalog));
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
