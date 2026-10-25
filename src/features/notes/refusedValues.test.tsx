import { createPlateEditor, Plate, PlateContent } from 'platejs/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { noteComponents } from './nodeComponents';
import { MaterialKit } from './plugins';

const STYLE_OR_CLASS = /(?:style|class)="([^"]*)"/g;

/** The note editor's own render of `value`, as the client draws it. */
function render(value: object[]) {
  const editor = createPlateEditor({
    components: noteComponents,
    plugins: MaterialKit,
    value: value as never,
  });
  return renderToStaticMarkup(
    <Plate editor={editor} readOnly>
      <PlateContent readOnly />
    </Plate>
  );
}

describe('values the document check refuses', () => {
  // A crafted paste is in the paster's editor before the room refuses it;
  // the editor draws none of its refused values either (the renderers share
  // the document check's predicates), a text mark or list style holding `;`
  // included (Epo Q380), while browser values draw as written.
  it('reach no style or class in the editor (security)', () => {
    const paragraph = (text: string) => ({
      children: [{ text }],
      type: 'p',
    });
    const html = render([
      {
        children: [
          {
            children: [paragraph('left')],
            type: 'column',
            width: 'zq;color:red',
          },
          { children: [paragraph('right')], type: 'column', width: '50%' },
        ],
        type: 'column_group',
      },
      {
        children: [
          {
            children: [
              { children: [paragraph('a')], type: 'td' },
              { children: [paragraph('b')], type: 'td' },
            ],
            type: 'tr',
          },
        ],
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
    ]);
    const attributes = [...html.matchAll(STYLE_OR_CLASS)].map(
      (match) => match[1]
    );
    expect(attributes.filter((value) => value.includes('zq'))).toEqual([]);
    expect(html).toContain('--column-width:50%');
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
});
