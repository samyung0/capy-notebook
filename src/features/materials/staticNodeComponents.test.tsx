import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MaterialKind } from '@/api/types';
import { exampleQuestions } from '@/features/questions/questionFixtures';
import {
  createMaterialDocument,
  flashcardsNode,
  type MaterialValue,
  materialRefNode,
  mermaidNode,
  quizNode,
} from './document';
import { EmbedViewContext } from './embeds/EmbedView';
import { MaterialPreview } from './MaterialPreview';

const STYLE_OR_CLASS = /(?:style|class)="([^"]*)"/g;

function renderMaterial(
  value: MaterialValue,
  metadata?: { isStandalone: boolean; kind: MaterialKind; title: string }
): string {
  return renderToStaticMarkup(
    <MaterialPreview
      content={createMaterialDocument(value)}
      isStandalone={metadata?.isStandalone}
      kind={metadata?.kind}
      title={metadata?.title}
    />
  );
}

describe('static study-block renderers', () => {
  it('keeps a block of an unknown type readable with a notice', () => {
    const html = renderToStaticMarkup(
      <MaterialPreview
        content={{
          schemaVersion: 1,
          value: [
            { children: [{ text: 'Before' }], id: 'a', type: 'p' },
            { children: [{ text: 'Newer' }], id: 'b', type: 'timeline' },
          ],
        }}
      />
    );
    expect(html.match(/data-unsupported-block="timeline"/g)).toHaveLength(1);
    expect(html).toContain('Before');
  });

  it('falls back to a deleted mention author identifier', () => {
    const html = renderMaterial([
      {
        children: [{ text: '' }],
        key: 'user_deleted_1',
        type: 'mention',
      },
    ]);

    expect(html.replace(/<[^>]+>/g, '')).toContain('@user_deleted_1');
  });

  it('renders task lists with read-only checked state', () => {
    const html = renderMaterial([
      {
        checked: true,
        children: [{ text: 'Completed task' }],
        indent: 1,
        listStyleType: 'todo',
        type: 'p',
      },
    ]);

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('line-through');
    expect(html).toContain('Completed task');
  });

  it('omits unsafe link URLs from static previews', () => {
    const html = renderMaterial([
      {
        children: [
          {
            children: [{ text: 'Unsafe link' }],
            type: 'a',
            url: 'javascript:alert(1)',
          },
        ],
        type: 'p',
      },
    ]);

    expect(html).toContain('Unsafe link');
    expect(html).not.toContain('href="javascript:');
  });

  it('renders persisted font style marks in material previews', () => {
    const html = renderMaterial([
      {
        children: [
          {
            backgroundColor: '#fef9c3',
            color: '#dc2626',
            fontSize: '24px',
            text: 'Styled text',
          },
        ],
        type: 'p',
      },
    ]);

    expect(html).toContain('class="note-fs"');
    expect(html).toContain('--note-fs:24');
    expect(html).toContain('color:#dc2626');
    expect(html).toContain('background-color:#fef9c3');
    expect(html).toContain('Styled text');
  });

  it('preserves a Mermaid caption in static rendering', () => {
    const html = renderMaterial([
      mermaidNode('mindmap\n  root((Topic))', 'Topic map', 'mindmap'),
    ]);

    expect(html).toContain('Topic map');
  });

  it('renders the metadata title only for a standalone custom material', () => {
    const value = [
      flashcardsNode(
        [{ back: 'Back', front: 'Front', id: 'card-1' }],
        'flashcards'
      ),
    ];
    const standalone = renderMaterial(value, {
      isStandalone: true,
      kind: 'flashcards',
      title: 'Renamed set',
    });
    const workspaceMaterial = renderMaterial(value, {
      isStandalone: false,
      kind: 'flashcards',
      title: 'Workspace set',
    });
    const embeddedInNote = renderMaterial(value, {
      isStandalone: false,
      kind: 'note',
      title: 'Note title',
    });

    expect(standalone).toContain('data-testid="standalone-material-title"');
    expect(standalone).toContain('>Renamed set</h1>');
    expect(workspaceMaterial).not.toContain(
      'data-testid="standalone-material-title"'
    );
    expect(workspaceMaterial).not.toContain('Workspace set');
    expect(embeddedInNote).not.toContain(
      'data-testid="standalone-material-title"'
    );
    expect(embeddedInNote).not.toContain('Note title');
  });

  it('renders semantic callout variants and code language labels in previews', () => {
    const html = renderMaterial([
      {
        children: [{ children: [{ text: 'Check this first' }], type: 'p' }],
        type: 'callout',
        variant: 'warning',
      },
      {
        children: [
          { children: [{ text: 'const ready = true;' }], type: 'code_line' },
        ],
        lang: 'typescript',
        type: 'code_block',
      },
    ]);

    expect(html).toContain('data-slate-variant="warning"');
    expect(html).toContain('border-solid-warning');
    expect(html).toContain('Check this first');
    expect(html).toContain('TypeScript');
    expect(html).toContain('const');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain(' ready = ');
    expect(html).toContain('true');
  });

  it('does not render code blocks with persisted list metadata as list items', () => {
    const html = renderMaterial([
      {
        children: [
          { children: [{ text: 'const ready = true;' }], type: 'code_line' },
        ],
        indent: 1,
        listStyleType: 'disc',
        type: 'code_block',
      },
    ]);

    expect(html).not.toContain('role="listitem"');
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<ol');
    expect(html).toContain('const ready');
  });

  it('preserves persisted column ratios in previews', () => {
    const html = renderMaterial([
      {
        children: [
          {
            children: [{ children: [{ text: 'Wide' }], type: 'p' }],
            type: 'column',
            width: '66.667%',
          },
          {
            children: [{ children: [{ text: 'Narrow' }], type: 'p' }],
            type: 'column',
            width: '33.333%',
          },
        ],
        type: 'column_group',
      },
    ]);

    expect(html).toContain('--column-width:66.667%');
    expect(html).toContain('--column-width:33.333%');
    expect(html).toContain('Wide');
    expect(html).toContain('Narrow');
  });

  // Share pages and previews draw a stored value the document check refuses
  // as it is (MaterialPreview falls back to the raw value): a column width
  // other than the editor's writes no style at all.
  it('styles no column width the document check refuses (security)', () => {
    const column = (text: string, width: string) => ({
      children: [{ children: [{ text }], type: 'p' }],
      type: 'column',
      width,
    });
    const html = renderToStaticMarkup(
      <MaterialPreview
        content={{
          schemaVersion: 1,
          value: [
            {
              children: [
                column('Left', '50%;color:red'),
                column('Right', '50%'),
              ],
              type: 'column_group',
            },
          ],
        }}
      />
    );
    expect(html).toContain('Left');
    // Only the right column is styled.
    expect(html.split('--column-width:')).toHaveLength(2);
    expect(html).toContain('--column-width:50%"');
  });

  // The same fallback: a table size, indent, element mark, media width, or a
  // text mark or list style holding `;` (Epo Q380) the document check refuses
  // reaches no style or class, while valid ones and browser values do.
  it('styles no table size, indent, element mark, media width or style value the document check refuses (security)', () => {
    const cell = (text: string) => ({
      children: [{ children: [{ text }], type: 'p' }],
      type: 'td',
    });
    const html = renderToStaticMarkup(
      <MaterialPreview
        content={{
          schemaVersion: 1,
          value: [
            {
              children: [{ children: [cell('a'), cell('b')], type: 'tr' }],
              colSizes: ['zq;color:red', 100],
              id: 't',
              marginLeft: 'zq',
              type: 'table',
            },
            { children: [{ text: 'indented' }], indent: 'zq fixed', type: 'p' },
            {
              backgroundColor: 'zq',
              children: [{ text: 'marked' }],
              color: 'zq',
              fontFamily: 'zq',
              fontSize: 'zq',
              type: 'p',
            },
            {
              children: [{ text: '' }],
              id: 'v',
              provider: 'youtube',
              type: 'video',
              videoId: 'dQw4w9WgXcQ',
              width: 'zq;color:red',
            },
            {
              children: [{ color: '#c0392b', text: 'kept' }],
              indent: 1,
              type: 'p',
            },
            {
              children: [
                {
                  backgroundColor: 'red;zq:1',
                  color: 'red;zq:1',
                  fontFamily: 'Georgia;zq:1',
                  fontSize: '12px;zq:1',
                  text: 'semicolons',
                },
              ],
              type: 'p',
            },
            {
              children: [{ text: 'listed' }],
              indent: 1,
              listStyleType: 'decimal;zq:1',
              type: 'p',
            },
            {
              children: [{ text: 'lettered' }],
              indent: 1,
              listStyleType: 'lower-alpha',
              type: 'p',
            },
            {
              children: [
                {
                  backgroundColor: 'color-mix(in srgb, red 50%, blue)',
                  color: 'var(--accent)',
                  fontFamily: '"Times New Roman", serif',
                  fontSize: '1.2em',
                  text: 'browser values',
                },
              ],
              type: 'p',
            },
          ],
        }}
      />
    );
    const attributes = [...html.matchAll(STYLE_OR_CLASS)].map(
      (match) => match[1]
    );
    expect(attributes.filter((value) => value.includes('zq'))).toEqual([]);
    expect(html).toContain('<col style="width:100px"/>');
    expect(html).toContain('slate-indent-1');
    expect(html).toContain('margin-left:24px');
    expect(html).toContain('color:#c0392b');
    expect(html).toContain('list-style-type:lower-alpha');
    expect(html).toContain('color:var(--accent)');
    expect(html).toContain('color-mix(in srgb, red 50%, blue)');
    expect(html).toContain('font-family:&quot;Times New Roman&quot;, serif');
    expect(html).toContain('font-size:1.2em');
  });

  it('renders every quiz question shape as a read-only answer review', () => {
    const html = renderMaterial([
      quizNode({ questions: exampleQuestions }, 'quiz'),
    ]);
    expect(html).toContain('Mitochondria');
    expect(html).toContain('Marking scheme');
    expect(html).toContain('Worked solution');
    expect(html).toContain('Unused choice');
    expect(html).not.toContain('contenteditable="true"');
  });

  it('renders flashcard fronts and backs as side-by-side rows', () => {
    const html = renderMaterial([
      flashcardsNode(
        [
          { back: 'Back one', front: 'Front one', id: 'card-1' },
          { back: 'Back two', front: 'Front two', id: 'card-2' },
        ],
        'flashcards'
      ),
    ]);

    expect(html).toContain('data-block-id="card-1"');
    expect(html).toContain('data-block-id="card-2"');
    expect(html).toContain('Front one');
    expect(html).toContain('Back two');
    expect(html).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
  });

  it("renders an embedded quiz or set with the page's embed renderer", () => {
    const html = renderToStaticMarkup(
      <EmbedViewContext.Provider
        value={({ materialId, refKind }) => <p>{`${refKind}:${materialId}`}</p>}
      >
        <MaterialPreview
          content={createMaterialDocument([
            materialRefNode('mat_child', 'quiz'),
          ])}
        />
      </EmbedViewContext.Provider>
    );
    expect(html).toContain('quiz:mat_child');
  });
});
