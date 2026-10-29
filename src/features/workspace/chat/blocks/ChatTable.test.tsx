import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import type { RowProps } from '../schema';
import { ChatTable } from './ChatTable';
import { CitationContext } from './Cite';
import { Prose } from './text';

const CELL = /<td[^>]*>.*?<\/td>/g;
const CITED_LAST_CELL =
  /^<td[^>]*>No ATP<sup[^>]*>.*>2<\/button><\/sup><\/td>$/;
const ROW_LINE = /Row \d/;
const HEADER_CELL = /<th(?:\s[^>]*)?>/;
// Passage 7 shows as source 1 and passage 9 as source 2.
const SHOWN: Record<number, number> = { 7: 1, 9: 2 };

const row = (props: RowProps) => ({
  partial: false,
  props,
  type: 'element',
  typeName: 'Row',
});

describe('ChatTable', () => {
  it("puts a row's citations at the end of its last cell (Q358)", () => {
    const html = renderToStaticMarkup(
      <CitationContext.Provider value={{ numberOf: (n) => SHOWN[n] }}>
        <ChatTable
          props={{
            columns: ['Mechanism', 'Energy'],
            passages: [7, 9],
            rows: [
              row({ cells: ['Diffusion', 'No ATP'], passages: [9] }),
              row({ cells: ['Active transport', 'ATP'] }),
            ],
          }}
        />
      </CitationContext.Provider>
    );
    const cells = (rowIndex: number) =>
      html.split('<tr')[rowIndex + 2].match(CELL) ?? [];

    const [first, last] = cells(0);
    expect(first).not.toContain('<sup');
    expect(last).toMatch(CITED_LAST_CELL);
    expect(cells(1).join('')).not.toContain('<sup');
    expect(html).not.toMatch(ROW_LINE);
    // The table's own sources stay under it.
    expect(html.split('</table>')[1]).toContain(m.chat_sources());
  });
});

describe('Markdown tables', () => {
  it("draw with the Table component's parts, without Streamdown's frame or buttons", () => {
    const md = renderToStaticMarkup(
      <Prose text={'| Tool | Result |\n|---|---|\n| `list_sources` | ok |'} />
    );
    const table = renderToStaticMarkup(
      <ChatTable
        props={{ columns: ['Tool'], rows: [row({ cells: ['ok'] })] }}
      />
    );
    const header = (html: string) => html.match(HEADER_CELL)?.[0];

    expect(md).not.toContain('data-streamdown="table-wrapper"');
    expect(md).not.toContain('<button');
    expect(md).toContain('<thead><tr');
    expect(header(md)).toBe(header(table));
  });
});
