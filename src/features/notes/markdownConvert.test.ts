import { serializeMd } from '@platejs/markdown';
import { createSlateEditor } from 'platejs';
import { describe, expect, it } from 'vitest';
import { LIST_INDENT_MAX } from '@/features/materials/document';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { noteMarkdownPlugin } from './markdown';
import { convertAgentMarkdown, markdownToDocument } from './markdownConvert';

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe('markdownToDocument', () => {
  it('turns agent markdown into the editor nodes a paste would give', () => {
    const { value } = markdownToDocument(
      [
        '# Tangents',
        'A **tangent** meets the [radius](javascript:alert(1)) at a right angle.',
        '- one point of contact',
        '| You see | Reason |\n| --- | --- |\n| 90° | tangent ⊥ radius |',
        fence('mermaid', 'flowchart LR\n  A --> B'),
        fence('quiz', 'questions: []'),
        fence('flashcards', 'cards:\n  - {front: Tangent, back: One point}'),
      ].join('\n\n')
    );
    expect(value.map((node) => node.type)).toEqual([
      'h1',
      'p',
      'p',
      'table',
      'mermaid',
      'material_ref',
      'material_ref',
    ]);
    const link = (value[1].children as { type?: string; url?: string }[]).find(
      (child) => child.type === 'a'
    );
    expect(link?.url).toBe('');
    expect(value[2]).toMatchObject({ listStyleType: 'disc' });
    expect(value[5]).toMatchObject({
      pending: 'questions: []',
      refKind: 'quiz',
    });
    expect(value[6]).toMatchObject({ refKind: 'flashcards' });
  });

  // Epo 2026-10-19: an import repairs an indent past the limit on entry, and
  // the editor's import and the collaboration server's bundle share this code.
  it('clamps a list nested past LIST_INDENT_MAX', () => {
    const depth = LIST_INDENT_MAX + 2;
    const source = Array.from(
      { length: depth },
      (_, level) => `${'  '.repeat(level)}- level ${level + 1}`
    ).join('\n');
    const indents = markdownToDocument(source).value.map((node) => node.indent);
    expect(indents).toHaveLength(depth);
    expect(Math.max(...(indents as number[]))).toBe(LIST_INDENT_MAX);
  });

  it('builds interactive blocks from html-embed fences and writes the same fence back', () => {
    const embed = fence(
      'html-embed',
      'caption: Tangent\nhtml: |\n  <svg id="fig"></svg>\n  <script>draw(40)</script>'
    );
    const { document } = convertAgentMarkdown(embed);
    const [node] = document.value;
    expect(node).toMatchObject({ caption: 'Tangent', type: 'html_embed' });
    expect(node.html).toContain('<svg id="fig"></svg>\n<script>draw(40)');
    const editor = createSlateEditor({
      plugins: [...StaticMaterialKit, noteMarkdownPlugin],
    });
    const written = serializeMd(editor, { value: document.value });
    expect(written).toContain('```html-embed');
    expect(markdownToDocument(written).value[0]).toMatchObject({
      caption: 'Tangent',
      html: node.html,
      type: 'html_embed',
    });
    expect(() =>
      convertAgentMarkdown(fence('html-embed', 'caption: t'))
    ).toThrow('needs html');
    expect(() =>
      convertAgentMarkdown(new Array(11).fill(embed).join('\n\n'))
    ).toThrow('at most 10 html-embed fences');
  });

  // Agent notes are read without MDX: its pass rewrote `class`/`for` and
  // script text inside fences, and a parse error in prose (`{,}`) cut the
  // note at the snippet's first `<`, leaving the fence without html.
  it('keeps agent html and prose exactly as written', () => {
    const html =
      '<label for="n" class="row">N</label>\n<input id="n" type="range">\n<!-- note -->\n<script>for(var i=0;i<3;i++){var b=i*2}</script>\n';
    const { document } = convertAgentMarkdown(
      [
        'Aid was $\\$19{,}940$ for the set {2, 3}.',
        fence('html-embed', `html: |\n${html.replace(/^/gm, '  ').trimEnd()}`),
        'After the block.',
      ].join('\n\n')
    );
    expect(document.value.map((node) => node.type)).toEqual([
      'p',
      'html_embed',
      'p',
    ]);
    expect(JSON.stringify(document.value[0])).toContain('for the set {2, 3}.');
    expect(document.value[1].html).toBe(html);
    expect(() =>
      convertAgentMarkdown(fence('html-embed', 'caption: a: b\nhtml: x'))
    ).toThrow('An html-embed fence is not YAML');
  });

  it('returns a draft per quiz or flashcards fence and refuses a broken one', () => {
    const { embedded } = convertAgentMarkdown(
      [
        fence('quiz', 'questions:\n  - {id: q1}'),
        '> Recap',
        fence('flashcards', 'cards:\n  - {front: A, back: B}'),
      ].join('\n\n')
    );
    expect(embedded).toEqual([
      { kind: 'quiz', questions: [{ id: 'q1' }] },
      { cards: [{ back: 'B', front: 'A' }], kind: 'flashcards' },
    ]);
    expect(() => convertAgentMarkdown(fence('quiz', 'questions: ['))).toThrow(
      'fence 1 (quiz) is not YAML'
    );
    expect(() =>
      convertAgentMarkdown(fence('flashcards', 'cards:\n  - {front: A}'))
    ).toThrow('fence 1 (flashcards) needs cards');
  });

  it('turns footnotes into superscript labels', () => {
    const { value } = markdownToDocument(
      "Mitochondria make the cell's ATP[^1].\n\n[^1]: About 30 to 32 per glucose."
    );
    expect(value).toMatchObject([
      {
        children: [
          { text: "Mitochondria make the cell's ATP" },
          { superscript: true, text: '1' },
          { text: '.' },
        ],
        type: 'p',
      },
      {
        children: [
          { superscript: true, text: '1' },
          { text: ' ' },
          { text: 'About 30 to 32 per glucose.' },
        ],
        type: 'p',
      },
    ]);
  });

  it('keeps a library figure as its reference and turns other images into links', () => {
    const { document } = convertAgentMarkdown(
      [
        '![Figure 16.10: The action potential (CC BY 4.0)](figure:fig_ab_12_v3)',
        '![a cell](https://example.com/cell.png)',
      ].join('\n\n')
    );
    const [figure, other] = document.value;
    expect(figure).toMatchObject({
      assetId: 'figure:fig_ab_12_v3',
      caption: [{ text: 'Figure 16.10: The action potential (CC BY 4.0)' }],
      type: 'img',
    });
    expect(figure).not.toHaveProperty('url');
    expect(other).toMatchObject({
      children: [
        {
          children: [{ text: 'a cell' }],
          type: 'a',
          url: 'https://example.com/cell.png',
        },
      ],
      type: 'p',
    });
  });

  it('gives a small figure half the width and a normal one the full width', () => {
    const { document } = convertAgentMarkdown(
      [
        '![Leaf](figure:fig_1 "small")',
        '![Root](figure:fig_2 "normal")',
        '![Stem](figure:fig_3)',
      ].join('\n\n')
    );
    const [small, normal, plain] = document.value;
    expect(small).toMatchObject({ assetId: 'figure:fig_1', width: '50%' });
    expect(normal).not.toHaveProperty('width');
    expect(plain).not.toHaveProperty('width');
  });
});
