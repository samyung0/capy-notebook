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
  // the document check's predicates).
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
  });
});
